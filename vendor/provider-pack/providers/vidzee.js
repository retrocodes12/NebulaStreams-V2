/**
 * Vidzee - Multi-language streaming provider
 * Adapted from WebStreamrMBG reference implementation
 * Supports: English, Hindi, Tamil, Telugu, Malayalam, Vietnamese, Bengali
 */

var crypto = require('crypto');

var API_KEY_URL = 'https://core.vidzee.wtf/api-key';
var SERVER_API_URL = 'https://player.vidzee.wtf/api/server';
var ENCRYPTION_KEY_SECRET = '4f2a9c7d1e8b3a6f0d5c2e9a7b1f4d8c';
var VIDZEE_REFERER = 'https://player.vidzee.wtf/';

var VIDZEE_SERVERS = [
  { sr: '3', flag: 'US', name: 'Achilles' },
  { sr: '5', flag: 'US', name: 'Drag' },
  { sr: '7', flag: 'IN', name: 'Hindi' },
  { sr: '9', flag: 'IN', name: 'Tamil' },
  { sr: '10', flag: 'IN', name: 'Telugu' },
  { sr: '11', flag: 'IN', name: 'Malayalam' }
];

var _cachedApiKey = null;
var _cachedApiKeyExpiry = 0;

function decryptApiKey(encryptedBase64) {
  var encrypted = Buffer.from(encryptedBase64, 'base64');
  if (encrypted.length <= 28) {
    throw new Error('Invalid API key response: too short');
  }

  var iv = encrypted.subarray(0, 12);
  var authTag = encrypted.subarray(12, 28);
  var ciphertext = encrypted.subarray(28);

  var derivedKey = crypto.createHash('sha256').update(ENCRYPTION_KEY_SECRET).digest();
  var decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv, { authTagLength: 16 });
  decipher.setAuthTag(authTag);

  var decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

function decryptServerUrl(encryptedLink, apiKey) {
  try {
    var decoded = Buffer.from(encryptedLink, 'base64').toString('utf8');
    var colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) return '';

    var ivBase64 = decoded.substring(0, colonIndex);
    var ciphertextBase64 = decoded.substring(colonIndex + 1);
    if (!ivBase64 || !ciphertextBase64) return '';

    var iv = Buffer.from(ivBase64, 'base64');
    var key = Buffer.alloc(32);
    key.write(apiKey, 'utf8');
    var ciphertext = Buffer.from(ciphertextBase64, 'base64');

    var decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    var decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    return '';
  }
}

function getApiKey() {
  var now = Date.now();
  if (_cachedApiKey && _cachedApiKeyExpiry > now) {
    return Promise.resolve(_cachedApiKey);
  }

  return fetch(API_KEY_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }
  })
    .then(function (res) {
      if (!res.ok) throw new Error('API key fetch failed: HTTP ' + res.status);
      return res.text();
    })
    .then(function (encryptedKey) {
      var key = decryptApiKey(encryptedKey.trim());
      _cachedApiKey = key;
      _cachedApiKeyExpiry = Date.now() + 3600000;
      return key;
    });
}

function fetchServerStreams(tmdbId, mediaType, season, episode, server, apiKey) {
  var url = SERVER_API_URL + '?id=' + tmdbId + '&sr=' + server.sr;
  if (mediaType === 'tv' && season) {
    url += '&ss=' + season + '&ep=' + (episode || 1);
  }

  return fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': VIDZEE_REFERER
    }
  })
    .then(function (res) {
      if (!res.ok) return null;
      return res.json();
    })
    .then(function (data) {
      if (!data || data.error || !Array.isArray(data.url) || data.url.length === 0) {
        return [];
      }

      var streams = [];
      var responseHeaders = data.headers || {};

      for (var i = 0; i < data.url.length; i++) {
        var stream = data.url[i];
        var decryptedUrl = decryptServerUrl(stream.link, apiKey);
        if (!decryptedUrl) continue;

        try {
          new URL(decryptedUrl);
        } catch (e) {
          continue;
        }

        var quality = 'Auto';
        if (decryptedUrl.includes('.m3u8')) {
          quality = '1080p';
        }

        var headers = { Referer: VIDZEE_REFERER };
        if (responseHeaders['User-Agent']) {
          headers['User-Agent'] = responseHeaders['User-Agent'];
        }

        streams.push({
          name: 'Vidzee',
          title: server.name + ' (' + server.flag + ') - ' + (stream.lang || 'Multi'),
          quality: quality,
          url: decryptedUrl,
          headers: headers
        });
      }

      return streams;
    })
    .catch(function () {
      return [];
    });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return getApiKey()
    .then(function (apiKey) {
      var promises = VIDZEE_SERVERS.map(function (server) {
        return fetchServerStreams(tmdbId, mediaType, season, episode, server, apiKey);
      });
      return Promise.all(promises);
    })
    .then(function (results) {
      var allStreams = [];
      for (var i = 0; i < results.length; i++) {
        if (Array.isArray(results[i])) {
          allStreams = allStreams.concat(results[i]);
        }
      }
      return allStreams;
    })
    .catch(function (err) {
      console.error('[Vidzee] Error:', err.message || err);
      return [];
    });
}

module.exports = { getStreams: getStreams };
