import { module, test } from 'qunit';
import document from 'global/document';
import window from 'global/window';
import {
  TEST_ONLY_SIMPLE_SELECTOR,
  simpleSelector,
  movingAverageBandwidthSelector,
  minRebufferMaxBandwidthSelector,
  lowestBitrateCompatibleVariantSelector,
  lastBandwidthSelector
} from '../src/playlist-selectors';
import Config from '../src/config';

module('Playlist Selectors', {
  beforeEach(assert) {
    const video = document.createElement('video');

    this.vhs = {
      tech_: {
        el() {
          return video;
        }
      },
      playlists: {
        main: {
          playlists: []
        }
      },
      playlistController_: {}
    };
  },
  afterEach() {

  }
});

test('Exponential moving average has a configurable decay parameter', function(assert) {
  let playlist;
  const instantAverage = movingAverageBandwidthSelector(1.0);

  this.vhs.playlists.main.playlists = [
    { attributes: { BANDWIDTH: 1 } },
    { attributes: { BANDWIDTH: 50 } },
    { attributes: { BANDWIDTH: 100 } }
  ];
  this.vhs.systemBandwidth = 50 * Config.BANDWIDTH_VARIANCE + 1;
  playlist = instantAverage.call(this.vhs);
  assert.equal(playlist.attributes.BANDWIDTH, 50, 'selected the middle playlist');

  this.vhs.systemBandwidth = 100 * Config.BANDWIDTH_VARIANCE + 1;
  playlist = instantAverage.call(this.vhs);
  assert.equal(playlist.attributes.BANDWIDTH, 100, 'selected the top playlist');

  const fiftyPercentDecay = movingAverageBandwidthSelector(0.5);

  this.vhs.systemBandwidth = 100 * Config.BANDWIDTH_VARIANCE + 1;
  playlist = fiftyPercentDecay.call(this.vhs);
  assert.equal(playlist.attributes.BANDWIDTH, 100, 'selected the top playlist');

  // average = decay * systemBandwidth + (1 - decay) * average
  // bandwidth = 0.5 * systemBandwidth + 0.5 * (100 * variance + 1)
  // 50 * variance + 1 = 0.5 * (systemBandwidth + (100 * variance + 1))
  // 2 * 50 * variance + 2 = systemBandwidth + (100 * variance + 1)
  // 100 * variance + 2 - (100 * variance + 1) = systemBandwidth
  // 1 = systemBandwidth
  this.vhs.systemBandwidth = 1;
  playlist = fiftyPercentDecay.call(this.vhs);
  assert.equal(playlist.attributes.BANDWIDTH, 50, 'selected the middle playlist');
});

test('Calling exponential moving average wont decay average unless new bandwidth data was provided', function(assert) {
  let playlist;
  const simSel = simpleSelector;
  const bandwidthAverages = [];

  const resetSimpleSelector = TEST_ONLY_SIMPLE_SELECTOR((...args) => {
    // second argument to simpleSelector is the average
    bandwidthAverages.push(args[1]);
    return simSel(...args);
  });

  this.vhs.playlists.main.playlists = [
    { attributes: { BANDWIDTH: 1 } },
    { attributes: { BANDWIDTH: 50 } },
    { attributes: { BANDWIDTH: 100 } }
  ];

  const fiftyPercentDecay = movingAverageBandwidthSelector(0.50);

  this.vhs.systemBandwidth = 50 * Config.BANDWIDTH_VARIANCE + 1;
  playlist = fiftyPercentDecay.call(this.vhs);
  assert.equal(playlist.attributes.BANDWIDTH, 50, 'selected the middle playlist');

  this.vhs.systemBandwidth = 1000 * Config.BANDWIDTH_VARIANCE + 1;
  playlist = fiftyPercentDecay.call(this.vhs);
  assert.equal(playlist.attributes.BANDWIDTH, 100, 'selected the top playlist');

  // using the systemBandwidth values above, 50->1000
  // we decay into 1000 after 50 iterations
  let i = 50;

  while (i--) {
    playlist = fiftyPercentDecay.call(this.vhs);
  }

  assert.equal(
    bandwidthAverages[bandwidthAverages.length - 1],
    bandwidthAverages[1],
    'bandwidth should only change when we get new bandwidth data'
  );

  resetSimpleSelector();
});

test(
  'minRebufferMaxBandwidthSelector picks highest rendition without rebuffering',
  function(assert) {
    const main = this.vhs.playlists.main;
    const currentTime = 0;
    let bandwidth = 2000;
    const duration = 100;
    const segmentDuration = 10;
    let timeUntilRebuffer = 5;
    const currentTimeline = 0;
    const syncController = {
      getSyncPoint: (playlist) => playlist.syncPoint
    };

    const settings = () => {
      return {
        main,
        currentTime,
        bandwidth,
        duration,
        segmentDuration,
        timeUntilRebuffer,
        currentTimeline,
        syncController
      };
    };

    main.playlists = [
      { attributes: { BANDWIDTH: 100 }, syncPoint: false },
      { attributes: { BANDWIDTH: 500 }, syncPoint: false },
      { attributes: { BANDWIDTH: 1000 }, syncPoint: false },
      { attributes: { BANDWIDTH: 2000 }, syncPoint: true },
      { attributes: { BANDWIDTH: 5000 }, syncPoint: false }
    ];

    let result = minRebufferMaxBandwidthSelector(settings());

    assert.equal(result.playlist, main.playlists[1], 'selected the correct playlist');
    assert.equal(result.rebufferingImpact, 0, 'impact on rebuffering is 0');

    main.playlists = [
      { attributes: { BANDWIDTH: 100 }, syncPoint: false },
      { attributes: { BANDWIDTH: 500 }, syncPoint: false },
      { attributes: { BANDWIDTH: 1000 }, syncPoint: true },
      { attributes: { BANDWIDTH: 2000 }, syncPoint: true },
      { attributes: { BANDWIDTH: 5000 }, syncPoint: false }
    ];

    result = minRebufferMaxBandwidthSelector(settings());

    assert.equal(result.playlist, main.playlists[2], 'selected the corerct playlist');
    assert.equal(result.rebufferingImpact, 0, 'impact on rebuffering is 0');

    bandwidth = 500;
    timeUntilRebuffer = 3;

    result = minRebufferMaxBandwidthSelector(settings());

    assert.equal(result.playlist, main.playlists[0], 'selected the correct playlist');
    assert.equal(result.rebufferingImpact, 1, 'impact on rebuffering is 1 second');
  }
);

test(
  'lowestBitrateCompatibleVariantSelector picks lowest non-audio playlist',
  function(assert) {
    // Set this up out of order to make sure that the function sorts all
    // playlists by bandwidth
    this.vhs.playlists.main.playlists = [
      { attributes: { BANDWIDTH: 10, CODECS: 'mp4a.40.2' } },
      { attributes: { BANDWIDTH: 100, CODECS: 'mp4a.40.2, avc1.4d400d' } },
      { attributes: { BANDWIDTH: 50, CODECS: 'mp4a.40.2, avc1.4d400d' } }
    ];

    const expectedPlaylist = this.vhs.playlists.main.playlists[2];
    const testPlaylist = lowestBitrateCompatibleVariantSelector.call(this.vhs);

    assert.equal(
      testPlaylist, expectedPlaylist,
      'Selected lowest compatible playlist with video assets'
    );
  }
);

test(
  'lowestBitrateCompatibleVariantSelector return null if no video exists',
  function(assert) {
    this.vhs.playlists.main.playlists = [
      { attributes: { BANDWIDTH: 50, CODECS: 'mp4a.40.2' } },
      { attributes: { BANDWIDTH: 10, CODECS: 'mp4a.40.2' } },
      { attributes: { BANDWIDTH: 100, CODECS: 'mp4a.40.2' } }
    ];

    const testPlaylist = lowestBitrateCompatibleVariantSelector.call(this.vhs);

    assert.equal(
      testPlaylist, null,
      'Returned null playlist since no video assets exist'
    );
  }
);

test('simpleSelector switches up even without resolution information', function(assert) {
  const main = this.vhs.playlists.main;

  main.playlists = [
    { attributes: { BANDWIDTH: 100 } },
    { attributes: { BANDWIDTH: 1000 } }
  ];

  const selectedPlaylist = simpleSelector({
    main,
    bandwidth: 2000,
    playerWidth: 1,
    playerHeight: 1,
    limitRenditionByPlayerDimensions: false
  });

  assert.equal(selectedPlaylist, main.playlists[1], 'selected the correct playlist');
});

// A set of playlists that were defined using non-traditional encoding.
// The resolutions were selected using a per-title encoding technique
// that ensures the resolution maximizes quality at a given bitrate.
const trickyPlaylists = [
  { attributes: { BANDWIDTH: 2362080, RESOLUTION: { width: 1280, height: 720 } } },
  { attributes: { BANDWIDTH: 1390830, RESOLUTION: { width: 1280, height: 720 } } },
  { attributes: { BANDWIDTH: 866114, RESOLUTION: { width: 1024, height: 576 } } },
  { attributes: { BANDWIDTH: 573028, RESOLUTION: { width: 768, height: 432 } } },
  { attributes: { BANDWIDTH: 3482070, RESOLUTION: { width: 1920, height: 1080 } } },
  { attributes: { BANDWIDTH: 6151620, RESOLUTION: { width: 1920, height: 1080 } } }
];

test('simpleSelector limits using resolution information when it exists', function(assert) {
  const main = this.vhs.playlists.main;

  main.playlists = trickyPlaylists;

  const selectedPlaylist = simpleSelector({
    main,
    bandwidth: 4194304,
    playerWidth: 444,
    playerHeight: 790,
    limitRenditionByPlayerDimensions: true,
    playlistController: {}
  });

  assert.equal(selectedPlaylist, main.playlists[3], 'selected the playlist with the lowest bandwidth and a resolution that exceeds player size in at least one dimension');
});

test('simpleSelector can take object fit into account', function(assert) {
  const main = this.vhs.playlists.main;

  main.playlists = trickyPlaylists;

  const selectedPlaylist = simpleSelector({
    main,
    bandwidth: 4194304,
    playerWidth: 444,
    playerHeight: 500,
    playerObjectFit: 'cover',
    limitRenditionByPlayerDimensions: true,
    playlistController: {}
  });

  assert.equal(selectedPlaylist, main.playlists[2], 'selected the playlist with the lowest bandwidth and a resolution that exceeds player size in both dimensions');
});

test('simpleSelector can not limit based on resolution information', function(assert) {
  const main = this.vhs.playlists.main;

  main.playlists = trickyPlaylists;

  const selectedPlaylist = simpleSelector({
    main,
    bandwidth: 4194304,
    playerWidth: 444,
    playerHeight: 790,
    limitRenditionByPlayerDimensions: false
  });

  assert.equal(selectedPlaylist, main.playlists[4], 'selected a playlist based solely on bandwidth');
});

test('simpleSelector chooses between current audio playlists for audio only', function(assert) {
  const audioPlaylists = [
    {id: 'foo'},
    {id: 'bar', attributes: {BANDWIDTH: 534216}}
  ];
  const playlistController = {
    getAudioTrackPlaylists_: () => audioPlaylists
  };
  const main = this.vhs.playlists.main;

  main.mediaGroups = {
    AUDIO: {
      main: {
        en: {id: 'en', playlists: audioPlaylists}
      }
    }
  };

  const selectedPlaylist = simpleSelector({
    main,
    bandwidth: Config.INITIAL_BANDWIDTH,
    playerWidth: 444,
    playerHeight: 790,
    limitRenditionByPlayerDimensions: false,
    playlistController
  });

  assert.equal(selectedPlaylist, audioPlaylists[1], 'selected an audio based solely on bandwidth');
});

test('simpleSelector leastPixelDiffSelector selects least pixel diff resolution.', function(assert) {
  const bandwidth = Config.INITIAL_BANDWIDTH;
  const main = this.vhs.playlists.main;
  const usePixelDiff = {leastPixelDiffSelector: true};

  main.playlists = [
    { attributes: { BANDWIDTH: bandwidth, RESOLUTION: { width: 768, height: 432 } } },
    { attributes: { BANDWIDTH: bandwidth, RESOLUTION: { width: 1024, height: 576 } } },
    { attributes: { BANDWIDTH: bandwidth, RESOLUTION: { width: 1280, height: 720 } } },
    { attributes: { BANDWIDTH: bandwidth, RESOLUTION: { width: 1920, height: 1080 } } }
  ];

  let pixelDiff;
  let nonPixelDiff;

  // +1 pixel
  pixelDiff = simpleSelector({
    main,
    bandwidth: Infinity,
    playerWidth: 1281,
    playerHeight: 721,
    limitRenditionByPlayerDimensions: true,
    playlistController: usePixelDiff
  });
  nonPixelDiff = simpleSelector({
    main,
    bandwidth: Infinity,
    playerWidth: 1281,
    playerHeight: 721,
    limitRenditionByPlayerDimensions: true,
    playlistController: {}
  });

  assert.equal(pixelDiff, main.playlists[2], '1281w x 721h pixel diff');
  assert.equal(nonPixelDiff, main.playlists[3], '1281w x 721h resolution plus one');

  // -1 pixel
  pixelDiff = simpleSelector({
    main,
    bandwidth: Infinity,
    playerWidth: 1279,
    playerHeight: 719,
    limitRenditionByPlayerDimensions: true,
    playlistController: usePixelDiff
  });
  nonPixelDiff = simpleSelector({
    main,
    bandwidth: Infinity,
    playerWidth: 1279,
    playerHeight: 719,
    limitRenditionByPlayerDimensions: true,
    playlistController: {}
  });

  assert.equal(pixelDiff, main.playlists[2], '1279w x 719h pixel diff');
  assert.equal(nonPixelDiff, main.playlists[2], '1279w x 719h resolution plus one');

  // equal to player resolution
  pixelDiff = simpleSelector({
    main,
    bandwidth: Infinity,
    playerWidth: 1280,
    playerHeight: 720,
    limitRenditionByPlayerDimensions: true,
    playlistController: usePixelDiff
  });
  nonPixelDiff = simpleSelector({
    main,
    bandwidth: Infinity,
    playerWidth: 1280,
    playerHeight: 720,
    limitRenditionByPlayerDimensions: true,
    playlistController: {}
  });

  assert.equal(pixelDiff, main.playlists[2], '1280w x 720h pixel diff');
  assert.equal(nonPixelDiff, main.playlists[2], '1280w x 720h resolution plus one');

  main.playlists.push({ attributes: { BANDWIDTH: bandwidth - 1, RESOLUTION: { width: 1280, height: 720 } } });
  main.playlists.push({ attributes: { BANDWIDTH: bandwidth + 1, RESOLUTION: { width: 1280, height: 720 } } });

  // equal to player resolution, chooses higher bandwidth
  pixelDiff = simpleSelector({
    main,
    bandwidth: Infinity,
    playerWidth: 1280,
    playerHeight: 720,
    limitRenditionByPlayerDimensions: true,
    playlistController: usePixelDiff
  });
  nonPixelDiff = simpleSelector({
    main,
    bandwidth: Infinity,
    playerWidth: 1280,
    playerHeight: 720,
    limitRenditionByPlayerDimensions: true,
    playlistController: {}
  });

  assert.equal(pixelDiff, main.playlists[5], '1280w x 720h pixel diff higher bandwidth');
  assert.equal(nonPixelDiff, main.playlists[5], '1280w x 720h resolution plus higher bandwidth');
});

test('lastBandwidthSelector uses customPixelRatio to pick rendition', function(assert) {
  let playlist;
  const bandwidth = 20;

  const oldGetComputedStyle = window.getComputedStyle;

  // Mock a 540p player.
  window.getComputedStyle = function() {
    return {
      width: 960,
      height: 540
    };
  };

  // Ensure system bandwith is greater than the rendition bandwidths.
  this.vhs.systemBandwidth = bandwidth + 10;
  // This is true by default.
  this.vhs.limitRenditionByPlayerDimensions = true;

  this.vhs.playlists.main.playlists = [
    { attributes: { BANDWIDTH: bandwidth, RESOLUTION: { width: 480, height: 270 } } },
    { attributes: { BANDWIDTH: bandwidth, RESOLUTION: { width: 960, height: 540 } } },
    { attributes: { BANDWIDTH: bandwidth, RESOLUTION: { width: 1440, height: 810 } } },
    { attributes: { BANDWIDTH: bandwidth, RESOLUTION: { width: 1920, height: 1080 } } }
  ];

  // Picks the lowest possible rendition
  this.vhs.customPixelRatio = 0;
  playlist = lastBandwidthSelector.call(this.vhs);
  assert.equal(playlist.attributes.RESOLUTION.height, 270, 'selected the lowest rendition');

  this.vhs.customPixelRatio = 0.5;
  playlist = lastBandwidthSelector.call(this.vhs);
  assert.equal(playlist.attributes.RESOLUTION.height, 270, 'selected the rendition with 270p');

  this.vhs.customPixelRatio = 1;
  playlist = lastBandwidthSelector.call(this.vhs);
  assert.equal(playlist.attributes.RESOLUTION.height, 540, 'selected the rendition with 540p');

  this.vhs.customPixelRatio = 1.5;
  playlist = lastBandwidthSelector.call(this.vhs);
  assert.equal(playlist.attributes.RESOLUTION.height, 810, 'selected the rendition with 810p');

  this.vhs.customPixelRatio = 2;
  playlist = lastBandwidthSelector.call(this.vhs);
  assert.equal(playlist.attributes.RESOLUTION.height, 1080, 'selected the rendition with 1080p');

  // Since the customPixelRatio sets the player dimension higher than any available rendition,
  // This value is entirely based on bandwidth.
  this.vhs.customPixelRatio = 4;
  playlist = lastBandwidthSelector.call(this.vhs);
  assert.equal(playlist.attributes.RESOLUTION.height, 270, 'selected the rendition based on bandwidth');

  window.getComputedStyle = oldGetComputedStyle;
});

test('movingAverageBandwidthSelector uses customPixelRatio to pick rendition', function(assert) {
  let playlist;
  const bandwidth = 20;
  const selectionFunction = movingAverageBandwidthSelector(1);
  const oldGetComputedStyle = window.getComputedStyle;

  // Mock a 540p player.
  window.getComputedStyle = function() {
    return {
      width: 960,
      height: 540
    };
  };

  // Ensure system bandwith is greater than the rendition bandwidths.
  this.vhs.systemBandwidth = bandwidth + 10;
  // This is true by default.
  this.vhs.limitRenditionByPlayerDimensions = true;

  this.vhs.playlists.main.playlists = [
    { attributes: { BANDWIDTH: bandwidth, RESOLUTION: { width: 480, height: 270 } } },
    { attributes: { BANDWIDTH: bandwidth, RESOLUTION: { width: 960, height: 540 } } },
    { attributes: { BANDWIDTH: bandwidth, RESOLUTION: { width: 1440, height: 810 } } },
    { attributes: { BANDWIDTH: bandwidth, RESOLUTION: { width: 1920, height: 1080 } } }
  ];

  // Picks the lowest possible rendition
  this.vhs.customPixelRatio = 0;
  playlist = selectionFunction.call(this.vhs);
  assert.equal(playlist.attributes.RESOLUTION.height, 270, 'selected the lowest rendition');

  this.vhs.customPixelRatio = 0.5;
  playlist = selectionFunction.call(this.vhs);
  assert.equal(playlist.attributes.RESOLUTION.height, 270, 'selected the rendition with 270p');

  this.vhs.customPixelRatio = 1;
  playlist = selectionFunction.call(this.vhs);
  assert.equal(playlist.attributes.RESOLUTION.height, 540, 'selected the rendition with 540p');

  this.vhs.customPixelRatio = 1.5;
  playlist = selectionFunction.call(this.vhs);
  assert.equal(playlist.attributes.RESOLUTION.height, 810, 'selected the rendition with 810p');

  this.vhs.customPixelRatio = 2;
  playlist = selectionFunction.call(this.vhs);
  assert.equal(playlist.attributes.RESOLUTION.height, 1080, 'selected the rendition with 1080p');

  // Since the customPixelRatio sets the player dimension higher than any available rendition,
  // This value is entirely based on bandwidth.
  this.vhs.customPixelRatio = 4;
  playlist = selectionFunction.call(this.vhs);
  assert.equal(playlist.attributes.RESOLUTION.height, 270, 'selected the rendition based on bandwidth');

  window.getComputedStyle = oldGetComputedStyle;
});
