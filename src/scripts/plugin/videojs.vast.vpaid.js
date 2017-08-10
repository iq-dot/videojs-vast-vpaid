const VASTClient = require('../ads/vast/VASTClient');
const VASTError = require('../ads/vast/VASTError');
const vastUtil = require('../ads/vast/vastUtil');
const VASTIntegrator = require('../ads/vast/VASTIntegrator');
const VPAIDIntegrator = require('../ads/vpaid/VPAIDIntegrator');
const async = require('../utils/async');
const dom = require('../utils/dom');
const playerUtils = require('../utils/playerUtils');
const utilities = require('../utils/utilityFunctions');
const logger = require('../utils/consoleLogger');

module.exports = function VASTPlugin (options) {
  let snapshot;
  const player = this;
  const vast = new VASTClient();
  let adsCanceled = false;
  let adTimeoutId = null;
  const defaultOpts = {
    // maximum amount of time in ms to wait to receive `adsready` from the ad
    // implementation after play has been requested. Ad implementations are
    // expected to load any dynamic libraries and make any requests to determine
    // ad policies for a video during this time.
    timeout: 500,

    // Whenever you play an add on IOS, the native player kicks in and we loose control of it. On very heavy pages the 'play' event
    // May occur after the video content has already started. This is wrong if you want to play a preroll ad that needs to happen before the user
    // starts watching the content. To prevent this usec
    iosPrerollCancelTimeout: 2000,

    // maximun amount of time for the ad to actually start playing. If this timeout gets
    // triggered the ads will be cancelled
    adCancelTimeout: 3000,

    // Boolean flag that configures the player to play a new ad before the user sees the video again
    // the current video
    playAdAlways: false,

    // Flag to enable or disable the ads by default.
    adsEnabled: true,

    // Boolean flag to enable or disable the resize with window.resize or orientationchange
    autoResize: true,

    // Path to the VPAID flash ad's loader
    vpaidFlashLoaderPath: '/VPAIDFlash.swf',

    // verbosity of console logging:
    // 0 - error
    // 1 - error, warn
    // 2 - error, warn, info
    // 3 - error, warn, info, log
    // 4 - error, warn, info, log, debug
    verbosity: 0
  };

  const settings = utilities.extend({}, defaultOpts, options || {});

  if (utilities.isUndefined(settings.getAdTag) && utilities.isDefined(settings.adTag)) {
    settings.getAdTag = (callback) => callback(null, settings.adTag);
  }

  if (utilities.isDefined(settings.adTagXML) && !utilities.isFunction(settings.adTagXML)) {
    return trackAdError(new VASTError('on VideoJS VAST plugin, the passed adTagXML option does not contain a function'));
  }

  if (!utilities.isFunction(settings.adTagXML) && !utilities.isFunction(settings.getAdTag)) {
    return trackAdError(new VASTError('on VideoJS VAST plugin, missing adTag on options object'));
  }

  logger.setVerbosity(settings.verbosity);

  vastUtil.runFlashSupportCheck(settings.vpaidFlashLoaderPath);// Necessary step for VPAIDFLASHClient to work.

  playerUtils.prepareForAds(player);

  if (settings.playAdAlways) {
    // No matter what happens we play a new ad before the user sees the video again.
    player.on('vast.contentEnd', () => {
      player.trigger('vast.reset');
    });
  }

  player.on('vast.firstPlay', tryToPlayPrerollAd);

  player.on('vast.reset', () => {
    // If we are reseting the plugin, we don't want to restore the content
    snapshot = null;
    cancelAds();
  });

  player.vast = {
    isEnabled: function () {
      return settings.adsEnabled;
    },

    enable: function () {
      settings.adsEnabled = true;
    },

    disable: function () {
      settings.adsEnabled = false;
    }
  };

  return player.vast;

  /** ** Local functions ****/
  function tryToPlayPrerollAd () {
    // We remove the poster to prevent flickering whenever the content starts playing
    console.log('SUGGESTV: Try to playPreRoll');
    player.pause();
    playerUtils.removeNativePoster(player);
    dom.addClass(player.el(), 'vjs-vast-ad-loading');

    playerUtils.once(player, ['vast.adsCancel', 'vast.adEnd'], () => {
      removeAdUnit();
      restoreVideoContent();
    });

    async.waterfall([
      checkAdsEnabled,
      preparePlayerForAd,
      startAdCancelTimeout,
      playPrerollAd
    ], (error, response) => {
      if (error) {
        trackAdError(error, response);
        dom.removeClass(player.el(), 'vjs-vast-ad-loading');
      } else {
        player.trigger('vast.adEnd');
      }
    });

    /** * Local functions ***/

    function removeAdUnit () {
      if (player.vast && player.vast.adUnit) {
        player.vast.adUnit = null; // We remove the adUnit
      }
    }

    function restoreVideoContent () {
      setupContentEvents();
      if (snapshot) {
        playerUtils.restorePlayerSnapshot(player, snapshot);
        snapshot = null;
      }
      player.play();
    }

    function setupContentEvents () {
      playerUtils.once(player, ['playing', 'vast.reset', 'vast.firstPlay'], (evt) => {
        if (evt.type !== 'playing') {
          return;
        }

        player.trigger('vast.contentStart');

        playerUtils.once(player, ['ended', 'vast.reset', 'vast.firstPlay'], (evt) => {
          if (evt.type === 'ended') {
            player.trigger('vast.contentEnd');
          }
        });
      });
    }

    function checkAdsEnabled (next) {
      if (settings.adsEnabled) {
        return next(null);
      }
      next(new VASTError('Ads are not enabled'));
    }

    function preparePlayerForAd (next) {
      if (canPlayPrerollAd()) {
        snapshot = playerUtils.getPlayerSnapshot(player);
        player.pause();
        addSpinnerIcon();

        if (player.paused()) {
          next(null);
        } else {
          playerUtils.once(player, ['playing'], () => {
            player.pause();
            next(null);
          });
        }
      } else {
        next(new VASTError('video content has been playing before preroll ad'));
      }
    }

    function canPlayPrerollAd () {
      return !utilities.isIPhone() || player.currentTime() <= settings.iosPrerollCancelTimeout;
    }

    function startAdCancelTimeout (next) {
      let adCancelTimeoutId;

      adsCanceled = false;

      adCancelTimeoutId = setTimeout(() => {
        trackAdError(new VASTError('timeout while waiting for the video to start playing', 402));
      }, settings.adCancelTimeout);
      adTimeoutId = adCancelTimeoutId;

      playerUtils.once(player, ['vast.adStart', 'vast.adsCancel'], clearAdCancelTimeout);

      /** * local functions ***/
      function clearAdCancelTimeout () {
        if (adCancelTimeoutId) {
          clearTimeout(adCancelTimeoutId);
          adCancelTimeoutId = null;
          adTimeoutId = null;
        }
      }

      next(null);
    }

    function addSpinnerIcon () {
      dom.addClass(player.el(), 'vjs-vast-ad-loading');
      playerUtils.once(player, ['vast.adStart', 'vast.adsCancel'], removeSpinnerIcon);
    }

    function removeSpinnerIcon () {
      // IMPORTANT NOTE: We remove the spinnerIcon asynchronously to give time to the browser to start the video.
      // If we remove it synchronously we see a flash of the content video before the ad starts playing.
      setTimeout(() => {
        dom.removeClass(player.el(), 'vjs-vast-ad-loading');
      }, 100);
    }
  }

  function cancelAds () {
    player.trigger('vast.adsCancel');
    adsCanceled = true;
  }

  function playPrerollAd (callback) {
    async.waterfall([
      getVastResponse,
      playAd
    ], callback);
  }

  function getVastResponse (callback) {
    if (settings.getAdTag) {
      return settings.getAdTag((error, adTag) => {
        if (error) {
          return trackAdError(error);
        }

        return vast.getVASTResponse(adTag, callback);
      });
    }

    vast.getVASTResponse(settings.adTagXML, callback);
  }

  function playAd (vastResponse, callback) {
    console.log('SUGGESTV: playAd');

    // If the state is not 'preroll?' it means the ads were canceled therefore, we break the waterfall
    if (adsCanceled) {
      return;
    }

    if (adTimeoutId) {
      clearTimeout(adTimeoutId);
      adTimeoutId = null;
    }

    const adIntegrator = isVPAID(vastResponse) ? new VPAIDIntegrator(player, settings) : new VASTIntegrator(player);
    let adFinished = false;

    playerUtils.once(player, ['vast.adStart', 'vast.adsCancel'], (evt) => {
      if (evt.type === 'vast.adStart') {
        addAdsLabel();
      }
    });

    playerUtils.once(player, ['vast.adEnd', 'vast.adsCancel'], removeAdsLabel);

    if (utilities.isIDevice()) {
      preventManualProgress();
    }

    player.vast.vastResponse = vastResponse;
    logger.debug('calling adIntegrator.playAd() with vastResponse:', vastResponse);
    player.vast.adUnit = adIntegrator.playAd(vastResponse, callback);

    /** * Local functions ****/
    function addAdsLabel () {
      if (adFinished || player.controlBar.getChild('AdsLabel')) {
        return;
      }

      player.controlBar.addChild('AdsLabel');
    }

    function removeAdsLabel () {
      player.controlBar.removeChild('AdsLabel');
      adFinished = true;
    }

    function preventManualProgress () {
      // IOS video clock is very unreliable and we need a 3 seconds threshold to ensure that the user forwarded/rewound the ad
      console.log('SUGGESTV: preventManualProgress');

      const PROGRESS_THRESHOLD = 3;
      let previousTime = 0;
      let skipad_attempts = 0;

      player.on('timeupdate', preventAdSeek);
      player.on('ended', preventAdSkip);

      playerUtils.once(player, ['vast.adEnd', 'vast.adsCancel', 'vast.adError'], stopPreventManualProgress);

      /** * Local functions ***/
      function preventAdSkip () {
        console.log('SUGGESTV: preventAdSkip');

        // Ignore ended event if the Ad time was not 'near' the end
        // and revert time to the previous 'valid' time
        if (player.duration() - previousTime > PROGRESS_THRESHOLD) {
          player.pause(true); // this reduce the video jitter if the IOS skip button is pressed
          player.play(true); // we need to trigger the play to put the video element back in a valid state
          player.currentTime(previousTime);
        }
      }

      function preventAdSeek () {
        console.log('SUGGESTV: preventAdSeek');

        const currentTime = player.currentTime();
        const progressDelta = Math.abs(currentTime - previousTime);

        if (progressDelta > PROGRESS_THRESHOLD) {
          skipad_attempts += 1;
          if (skipad_attempts >= 2) {
            player.pause(true);
          }
          player.currentTime(previousTime);
        } else {
          previousTime = currentTime;
        }
      }

      function stopPreventManualProgress () {
        player.off('timeupdate', preventAdSeek);
        player.off('ended', preventAdSkip);
      }
    }
  }

  function trackAdError (error, vastResponse) {
    player.trigger({type: 'vast.adError', error: error});
    cancelAds();
    logger.error('AD ERROR:', error.message, error, vastResponse);
  }

  function isVPAID (vastResponse) {
    let i;
    let len;
    const mediaFiles = vastResponse.mediaFiles;

    for (i = 0, len = mediaFiles.length; i < len; i++) {
      if (vastUtil.isVPAID(mediaFiles[i])) {
        return true;
      }
    }

    return false;
  }
};
