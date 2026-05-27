(function () {
    function prefetchRecapAssets(recapId) {
        fetch('/api/recap/' + recapId)
            .then(function(r) { return r.json(); })
            .then(function(data) {
                try { sessionStorage.setItem('recap_cache_' + recapId, JSON.stringify(data)); } catch(e) {}
                var activities = (data && data.slides && data.slides.activities) || [];
                activities.forEach(function(a) {
                    if (a && a.dat && a.dat.image_url) {
                        new Image().src = a.dat.image_url;
                    }
                });
            })
            .catch(function() {});

        [
            '/static/recap.css',
            '/static/js/recap.js',
            'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js',
            'https://unpkg.com/html-to-image@1.11.11/dist/html-to-image.js',
            '/static/imag/const_paper.webp',
            '/static/imag/crumple-texture.jpg',
            '/static/imag/NoteCard.svg',
            '/static/imag/clip/clip_full.png',
            '/static/imag/clip/clip_top.png',
        ].forEach(function(url) {
            var link = document.createElement('link');
            link.rel = 'prefetch';
            link.href = url;
            document.head.appendChild(link);
        });
    }

    const recapId = window.RECAP_STATUS_ID;
    if (recapId && window.RECAP_READY) { prefetchRecapAssets(recapId); }
    if (!recapId || window.RECAP_READY) return;

    const btn      = document.getElementById('recap-btn');
    const progress = document.getElementById('btn-progress');
    const statusEl = document.getElementById('recap-status');
    const hintEl   = document.getElementById('recap-hint');

    function setProgress(pct) {
        if (progress) progress.style.width = pct + '%';
    }

    function setStatus(html) {
        if (statusEl) statusEl.innerHTML = html;
    }

    function setHint(html) {
        if (!hintEl) return;
        if (html) {
            hintEl.innerHTML = html;
            hintEl.style.display = '';
        } else {
            hintEl.style.display = 'none';
        }
    }

    function enable() {
        if (btn) btn.classList.remove('disabled');
    }

    function onDone(readyUrl) {
        setProgress(100);
        enable();
        if (btn) btn.href = readyUrl;
        setStatus('Your recap is ready!');
        setHint(null);
        prefetchRecapAssets(recapId);
    }

    function handleMessage(msg) {
        var status = msg.status;
        var pct    = msg.percent || 0;

        if (status === 'done') {
            onDone(msg.ready_url || ('/recap/' + recapId));
            return;
        }
        if (status === 'error') {
            setProgress(0);
            setStatus('Something went wrong. Click <a href="javascript:location.reload()">here</a> to refresh.');
            setHint(null);
            return;
        }
        if (status === 'queued') {
            setProgress(0);
            var pos = msg.queue_position || '?';
            setStatus("We'll start generating your recap soon. You're position <span class=\"hl\">" + pos + "</span> in line.");
            setHint("This might take a while, you can <a href=\"/photos\">browse photos</a> while waiting. We'll send you an email when it's done generating!");
            return;
        }
        if (status === 'running') {
            setProgress(pct);
            if (pct >= 35 && pct < 85) {
                setStatus("We're fetching your assignment data. <span class=\"hl\">" + pct + "%</span> done.");
            } else {
                setStatus("We're generating your recap right now…");
            }
            setHint("This could take a few minutes, you can <a href=\"/photos\">browse photos</a> while waiting.");
            return;
        }
    }

    var finished = false;

    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(protocol + '//' + location.host + '/ws/job/' + recapId);

    ws.onmessage = function (event) {
        var message;
        try { message = JSON.parse(event.data); } catch (e) { return; }
        if (message.status === 'done' || message.status === 'error') finished = true;
        handleMessage(message);
    };

    ws.onerror = function () {
        if (finished) return;
        setStatus('Connection error. Click <a href="javascript:location.reload()">here</a> to refresh.');
        setHint(null);
    };

    ws.onclose = function () {
        if (finished) return;
        setStatus('Connection lost. Click <a href="javascript:location.reload()">here</a> to refresh.');
        setHint(null);
    };
}());
