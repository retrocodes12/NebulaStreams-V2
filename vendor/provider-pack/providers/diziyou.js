var cheerio = require("cheerio-without-node-native");

// Protokolü HTTP denemek sertifika hatasını (Trust Anchor) aşabilir
var BASE_URL = 'https://www.diziyou.one'; 
var STORAGE_URL = 'https://storage.diziyou.one';

var HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': BASE_URL + '/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Connection': 'keep-alive' // Lite için bağlantıyı açık tutmak iyidir
};

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    return new Promise(function(resolve, reject) {
        if (mediaType !== 'tv') return resolve([]);

        console.log('[DiziYou] İstek Atılıyor:', tmdbId);

        // 1. TMDB İsteği (Headers eklendi)
        var tmdbUrl = 'https://api.themoviedb.org/3/tv/' + tmdbId + '?language=tr-TR&api_key=4ef0d7355d9ffb5151e987764708ce96';

        fetch(tmdbUrl, { headers: { 'User-Agent': HEADERS['User-Agent'] } })
            .then(function(res) { return res.json(); })
            .then(function(data) {
                var query = data.name || '';
                if (!query) throw new Error('İsim yok');
                
                // 2. Arama Yap
                var searchUrl = BASE_URL + '/?s=' + encodeURIComponent(query);
                return fetch(searchUrl, { headers: HEADERS });
            })
            .then(function(res) { return res.text(); })
            .then(function(html) {
                // Cheerio belleği çok yorar, Lite için hızlıca parse etmeliyiz
                var $ = cheerio.load(html);
                var firstLink = $('div.incontent div#list-series div#categorytitle a').first().attr('href');
                
                if (!firstLink) {
                    // Eğer kategori başlığında bulamazsa genel a etiketlerine bak
                    firstLink = $('.list-series a').first().attr('href') || $('.post-title a').first().attr('href');
                }

                if (!firstLink) throw new Error('Dizi linki bulunamadı');

                // 3. Bölüm URL Oluşturma (Regex yerine güvenli split)
                var slug = firstLink.split('/').filter(Boolean).pop();
                var epUrl = BASE_URL + '/' + slug + '-' + seasonNum + '-sezon-' + episodeNum + '-bolum/';
                
                console.log('[DiziYou] Hedef:', epUrl);
                return fetch(epUrl, { headers: HEADERS });
            })
            .then(function(res) { return res.text(); })
            .then(function(epHtml) {
                var $ = cheerio.load(epHtml);
                var playerSrc = $('#diziyouPlayer').attr('src');
                
                if (!playerSrc) throw new Error('Player yok');

                // itemId Ayıklama
                var itemId = playerSrc.split('/').pop().replace('.html', '').split('?')[0];

                var streams = [];
                var subtitles = [{
                    label: 'Turkish',
                    url: STORAGE_URL + '/subtitles/' + itemId + '/tr.vtt'
                }];

                // Dublaj/Altyazı tespiti (Daha hafif kontrol)
                var hasSub = epHtml.indexOf('turkceAltyazili') !== -1;
                var hasDub = epHtml.indexOf('turkceDublaj') !== -1;

                if (hasSub) {
                    streams.push({
                        name: '⌜ DiziYou ⌟ | Altyazılı',
                        url: STORAGE_URL + '/episodes/' + itemId + '/play.m3u8'
                    });
                }
                if (hasDub) {
                    streams.push({
                        name: '⌜ DiziYou ⌟ | Dublaj',
                        url: STORAGE_URL + '/episodes/' + itemId + '_tr/play.m3u8'
                    });
                }

                // Fallback
                if (streams.length === 0) {
                    streams.push({
                        name: '⌜ DiziYou ⌟ | Video',
                        url: STORAGE_URL + '/episodes/' + itemId + '/play.m3u8'
                    });
                }

                resolve(streams.map(function(s) {
                    return {
                        name: s.name,
                        url: s.url,
                        quality: 'Auto',
                        headers: { 'Referer': BASE_URL + '/' },
                        subtitles: subtitles
                    };
                }));
            })
            .catch(function(err) {
                console.error('[DiziYou] Hata Detayı:', err.message);
                resolve([]);
            });
    });
}

module.exports = { getStreams: getStreams };
