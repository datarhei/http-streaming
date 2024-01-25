/**
 * mux.js
 *
 * Copyright (c) FOSS GmbH
 * Licensed Apache-2.0 https://github.com/videojs/mux.js/blob/master/LICENSE
 *
 * Reads in-band SEI messages out of FMP4 segments.
 */

import { discardEmulationPreventionBytes } from "mux.js/lib/tools/caption-packet-parser";
import findBox from "mux.js/lib/mp4/find-box.js";
import parseTfdt from "mux.js/lib/tools/parse-tfdt.js";
import parseTrun from "mux.js/lib/tools/parse-trun.js";
import parseTfhd from "mux.js/lib/tools/parse-tfhd.js";
import window from "global/window";

/**
 * Maps an offset in the mdat to a sample based on the the size of the samples.
 * Assumes that `parseSamples` has been called first.
 *
 * @param {Number} offset - The offset into the mdat
 * @param {Object[]} samples - An array of samples, parsed using `parseSamples`
 * @return {?Object} The matching sample, or null if no match was found.
 *
 * @see ISO-BMFF-12/2015, Section 8.8.8
 **/
var mapToSample = function (offset, samples) {
  var approximateOffset = offset;

  for (var i = 0; i < samples.length; i++) {
    var sample = samples[i];

    if (approximateOffset < sample.size) {
      return sample;
    }

    approximateOffset -= sample.size;
  }

  return null;
};

/**
 * Parse a supplemental enhancement information (SEI) NAL unit.
 *
 * @param bytes {Uint8Array} the bytes of a SEI NAL unit
 * @return {object[]} Sei[] - List of the SEI messages in the NAL unit
 * @return {Number} Sei[].payloadType - Kind of SEI message
 * @return {Number} Sei[].payloadLength - Length of the SEI message payload
 * @return {Uint8Array} Sei[].payload - SEI message payload
 * @see Rec. ITU-T H.264, 7.3.2.3.1
 */
const parseSei = function (bytes) {
  let i = 0,
    results = [],
    payloadType = 0,
    payloadSize = 0;

  // go through the sei_rbsp parsing each each individual sei_message
  while (i < bytes.byteLength) {
    // stop once we have hit the end of the sei_rbsp
    //if (bytes[i] === RBSP_TRAILING_BITS) {
    //  break;
    //}

    // Parse payload type
    while (bytes[i] === 0xff) {
      payloadType += 255;
      i++;
    }
    payloadType += bytes[i++];

    // Parse payload size
    while (bytes[i] === 0xff) {
      payloadSize += 255;
      i++;
    }
    payloadSize += bytes[i++];

    if (payloadSize !== 0) {
      results.push({
        payloadType: payloadType,
        payloadSize: payloadSize,
        payload: bytes.subarray(i, i + payloadSize),
      });
    }

    // skip the payload and parse the next message
    i += payloadSize;
    payloadType = 0;
    payloadSize = 0;
  }

  return results;
};

/**
 * Finds SEI nal units contained in a Media Data Box.
 * Assumes that `parseSamples` has been called first.
 *
 * @param {Uint8Array} avcStream - The bytes of the mdat
 * @param {Object[]} samples - The samples parsed out by `parseSamples`
 * @param {Number} trackId - The trackId of this video track
 * @return {Object[]} seiNals - the parsed SEI NALUs found.
 *
 * @see ISO-BMFF-12/2015, Section 8.1.1
 * @see Rec. ITU-T H.264, 7.3.2.3.1
 **/
var findSeiNals = function (avcStream, samples, trackId) {
  var avcView = new DataView(
      avcStream.buffer,
      avcStream.byteOffset,
      avcStream.byteLength
    ),
    result = {
      logs: [],
      nals: [],
    },
    seiNal,
    i,
    length,
    lastMatchedSample,
    data,
    matchingSample;

  for (i = 0; i + 4 < avcStream.length; i += length) {
    length = avcView.getUint32(i);
    i += 4;

    // Bail if this doesn't appear to be an H264 stream
    if (length <= 0) {
      continue;
    }

    switch (avcStream[i] & 0x1f) {
      case 0x06:
        data = avcStream.subarray(i + 1, i + 1 + length);
        matchingSample = mapToSample(i, samples);

        seiNal = {
          nalUnitType: "sei_rbsp",
          size: length,
          data: data,
          escapedRBSP: discardEmulationPreventionBytes(data),
          trackId: trackId,
        };

        if (matchingSample) {
          seiNal.pts = matchingSample.pts;
          seiNal.dts = matchingSample.dts;
          lastMatchedSample = matchingSample;
        } else if (lastMatchedSample) {
          // If a matching sample cannot be found, use the last
          // sample's values as they should be as close as possible
          seiNal.pts = lastMatchedSample.pts;
          seiNal.dts = lastMatchedSample.dts;
        } else {
          result.logs.push({
            level: "warn",
            message:
              "We've encountered a nal unit without data at " +
              i +
              " for trackId " +
              trackId +
              ". See mux.js#223.",
          });
          break;
        }

        result.nals.push(seiNal);
        break;
      default:
        break;
    }
  }

  return result;
};

/**
  * Parses sample information out of Track Run Boxes and calculates
  * the absolute presentation and decode timestamps of each sample.
  *
  * @param {Array<Uint8Array>} truns - The Trun Run boxes to be parsed
  * @param {Number|BigInt} baseMediaDecodeTime - base media decode time from tfdt
      @see ISO-BMFF-12/2015, Section 8.8.12
  * @param {Object} tfhd - The parsed Track Fragment Header
  *   @see inspect.parseTfhd
  * @return {Object[]} the parsed samples
  *
  * @see ISO-BMFF-12/2015, Section 8.8.8
 **/
var parseSamples = function (truns, baseMediaDecodeTime, tfhd) {
  var currentDts = baseMediaDecodeTime;
  var defaultSampleDuration = tfhd.defaultSampleDuration || 0;
  var defaultSampleSize = tfhd.defaultSampleSize || 0;
  var trackId = tfhd.trackId;
  var allSamples = [];

  truns.forEach(function (trun) {
    // Note: We currently do not parse the sample table as well
    // as the trun. It's possible some sources will require this.
    // moov > trak > mdia > minf > stbl
    var trackRun = parseTrun(trun);
    var samples = trackRun.samples;

    samples.forEach(function (sample) {
      if (sample.duration === undefined) {
        sample.duration = defaultSampleDuration;
      }
      if (sample.size === undefined) {
        sample.size = defaultSampleSize;
      }
      sample.trackId = trackId;
      sample.dts = currentDts;
      if (sample.compositionTimeOffset === undefined) {
        sample.compositionTimeOffset = 0;
      }

      if (typeof currentDts === "bigint") {
        sample.pts = currentDts + window.BigInt(sample.compositionTimeOffset);
        currentDts += window.BigInt(sample.duration);
      } else {
        sample.pts = currentDts + sample.compositionTimeOffset;
        currentDts += sample.duration;
      }
    });

    allSamples = allSamples.concat(samples);
  });

  return allSamples;
};

/**
 * Parses out SEI nals from an FMP4 segment's video tracks.
 *
 * @param {Uint8Array} segment - The bytes of a single segment
 * @param {Number} videoTrackId - The trackId of a video track in the segment
 * @return {Object.<Number, Object[]>} A mapping of video trackId to
 *   a list of seiNals found in that track
 **/
var parseSeiNals = function (segment, videoTrackId) {
  // To get the samples
  var trafs = findBox(segment, ["moof", "traf"]);
  // To get SEI NAL units
  var mdats = findBox(segment, ["mdat"]);
  var seiNals = { nals: [], logs: [] };
  var mdatTrafPairs = [];

  // Pair up each traf with a mdat as moofs and mdats are in pairs
  mdats.forEach(function (mdat, index) {
    var matchingTraf = trafs[index];
    mdatTrafPairs.push({
      mdat: mdat,
      traf: matchingTraf,
    });
  });

  mdatTrafPairs.forEach(function (pair) {
    var mdat = pair.mdat;
    var traf = pair.traf;
    var tfhd = findBox(traf, ["tfhd"]);
    // Exactly 1 tfhd per traf
    var headerInfo = parseTfhd(tfhd[0]);
    var trackId = headerInfo.trackId;
    var tfdt = findBox(traf, ["tfdt"]);
    // Either 0 or 1 tfdt per traf
    var baseMediaDecodeTime =
      tfdt.length > 0 ? parseTfdt(tfdt[0]).baseMediaDecodeTime : 0;
    var truns = findBox(traf, ["trun"]);
    var samples;
    var result;

    // Only parse video data for the chosen video track
    if (videoTrackId === trackId && truns.length > 0) {
      samples = parseSamples(truns, baseMediaDecodeTime, headerInfo);

      result = findSeiNals(mdat, samples, trackId);

      seiNals.nals = seiNals.nals.concat(result.nals);
      seiNals.logs = seiNals.logs.concat(result.logs);
    }
  });

  return seiNals;
};

/**
 * Parses out inband SEI from an MP4 container and returns SEI objects.
 * Assumes that `probe.getVideoTrackIds` and `probe.timescale` have been called first
 *
 * @param {Uint8Array} segment - The fmp4 segment containing embedded captions
 * @param {Number} trackId - The id of the video track to parse
 * @param {Number} timescale - The timescale for the video track from the init segment
 *
 * @return {?Object[]} parsedSei - A list of SEI or null if no video tracks
 * @return {Array} parsedSei.seiNals[] - List of all found SEI NALUs
 * @return {Array} parsedSei.logs[] - List of log messages
 **/
var parseEmbeddedSei = function (segment, trackId) {
  // the ISO-BMFF spec says that trackId can't be zero, but there's some broken content out there
  if (trackId === null) {
    return null;
  }

  const seiNals = parseSeiNals(segment, trackId);

  return {
    seiNals: seiNals.nals,
    logs: seiNals.logs,
  };
};

/**
 * Parse SEI NALUs from a fmp4 segment that can be used by video.js
 **/
var SeiParser = function () {
  var isInitialized = false;

  // Stores segments seen before trackId and timescale are set
  var segmentCache;
  // Stores video track ID of the track being parsed
  var trackId;
  // Stores the timescale of the track being parsed
  var timescale;

  /**
   * A method to indicate whether a CaptionParser has been initalized
   * @returns {Boolean}
   **/
  this.isInitialized = function () {
    return isInitialized;
  };

  /**
   * Initializes the underlying CaptionStream, SEI NAL parsing
   * and management, and caption collection
   **/
  this.init = function (options) {
    isInitialized = true;
  };

  /**
   * Determines if a new video track will be selected
   * or if the timescale changed
   * @return {Boolean}
   **/
  this.isNewInit = function (videoTrackIds, timescales) {
    if (
      (videoTrackIds && videoTrackIds.length === 0) ||
      (timescales &&
        typeof timescales === "object" &&
        Object.keys(timescales).length === 0)
    ) {
      return false;
    }

    return trackId !== videoTrackIds[0] || timescale !== timescales[trackId];
  };

  /**
   * Parses out SEI NALUs and return them
   *
   * @param {Uint8Array} segment - The fmp4 segment containing embedded captions
   * @param {Number[]} videoTrackIds - A list of video tracks found in the init segment
   * @param {Object.<Number, Number>} timescales - The timescales found in the init segment
   **/
  this.parse = function (segment, videoTrackIds, timescales) {
    if (!this.isInitialized()) {
      return null;

      // This is not likely to be a video segment
    } else if (!videoTrackIds || !timescales) {
      return null;
    } else if (this.isNewInit(videoTrackIds, timescales)) {
      // Use the first video track only as there is no
      // mechanism to switch to other video tracks
      trackId = videoTrackIds[0];
      timescale = timescales[trackId];

      // If an init segment has not been seen yet, hold onto segment
      // data until we have one.
      // the ISO-BMFF spec says that trackId can't be zero, but there's some broken content out there
    } else if (trackId === null || !timescale) {
      segmentCache.push(segment);
      return null;
    }

    // Now that a timescale and trackId is set, parse cached segments
    while (segmentCache.length > 0) {
      var cachedSegment = segmentCache.shift();

      this.parse(cachedSegment, videoTrackIds, timescales);
    }

    const parsedData = parseEmbeddedSei(segment, trackId);

    const parsedSei = {
      sei: [],
      logs: [],
    };

    if (parsedData && parsedData.logs) {
      parsedSei.logs = parsedSei.logs.concat(parsedData.logs);
    }

    if (parsedData === null || !parsedData.seiNals) {
      if (parsedSei.logs.length) {
        return { logs: parsedSei.logs, sei: [] };
      }
      return null;
    }

    for (let i = 0; i < parsedData.seiNals.length; i++) {
      const seiNal = parsedData.seiNals[i];
      const seis = parseSei(seiNal.escapedRBSP);

      for (let j = 0; j < seis.length; j++) {
        let event = {
          pts: seiNal.pts / timescale,
          payloadType: seis[j].payloadType,
          payloadSize: seis[j].payloadSize,
          payload: seis[j].payload,
        };

        parsedSei.sei.push(event);
      }
    }

    return parsedSei;
  };

  /**
   * Reset SEI parser
   **/
  this.reset = function () {
    segmentCache = [];
    trackId = null;
    timescale = null;
  };

  this.reset();
};

export default SeiParser;
