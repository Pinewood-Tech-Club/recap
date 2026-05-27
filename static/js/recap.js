// Force-decode background image so it's in GPU memory before slide 2 appears
{ const _i = new Image(); _i.src = '/static/imag/const_paper.webp'; if (_i.decode) _i.decode().catch(() => {}); }

const slide_ids = ["slide1", "slide2", "slide3", "slide4"]
var cur_slide = 0;
let RECAP_DATA = null;
let _dataReadyResolve;
const dataReady = new Promise(r => { _dataReadyResolve = r; });
let slide1Snap = false;
let slide1Animating = false;
let _slide1Timeouts = [];
let slide2Snap = false;
let slide2Animating = false;
let slide2Gen = 0;
let slide3Snap = false;
let slide3Animating = false;
let slide3Gen = 0;
let slide4Snap = false;
let slide4Animating = false;
let slide4Gen = 0;

const slide_on_enter = {
    slide1: () => { reset_slide1(); make_title_animate(); },
    slide2: () => { reset_slide2(); animate_slide2(); },
    slide3: () => { reset_slide3(); animate_slide3(); },
    slide4: () => { reset_slide4(); animate_slide4(); },
};

const slide_on_exit = {
    slide1: () => { slide1Snap = false; slide1Animating = false; _slide1Timeouts.forEach(t => clearTimeout(t)); _slide1Timeouts = []; },
    slide2: () => { slide2Gen++; slide2Snap = false; slide2Animating = false; },
    slide3: () => { slide3Gen++; slide3Snap = false; slide3Animating = false; },
    slide4: () => { slide4Gen++; slide4Snap = false; slide4Animating = false; },
};

function go_to_slide(index) {
    if (index < 0 || index >= slide_ids.length) return;
    const leaving_id = slide_ids[cur_slide];
    if (slide_on_exit[leaving_id]) slide_on_exit[leaving_id]();
    document.getElementById(leaving_id).style.display = "none";
    cur_slide = index;
    const id = slide_ids[cur_slide];
    document.getElementById(id).style.display = "";
    if (slide_on_enter[id]) slide_on_enter[id]();
    _updateDownloadBtn();
}

function _updateDownloadBtn() {
    const btn = document.getElementById('download-btn');
    if (!btn) return;
    const id = slide_ids[cur_slide];
    btn.style.display = (id === 'slide1' || id === 'slide-thanks') ? 'none' : '';
}

function _bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
}

async function _buildFontEmbedCSS() {
    try {
        const cssUrl = 'https://fonts.googleapis.com/css2?family=Noto+Serif:ital,wght@0,100..900;1,100..900&display=swap';
        let css = await fetch(cssUrl).then(r => r.text());
        const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(m => m[1]))];
        await Promise.all(urls.map(async url => {
            const buf = await fetch(url).then(r => r.arrayBuffer());
            const mime = url.includes('.woff2') ? 'font/woff2' : 'font/woff';
            css = css.replaceAll(url, `data:${mime};base64,${_bufToBase64(buf)}`);
        }));
        return css;
    } catch (e) {
        console.warn('Font embed failed, download may use system font:', e);
        return '';
    }
}

// On mobile/iosapp, slide fills full screen (bg extends). We scale so that the
// 9:16 content zone = 1080×1920, then center-crop to strip the extended bg margins.
async function _captureSlide1080x1920(slideEl) {
    const rect = slideEl.getBoundingClientRect();
    const isMobile = window.matchMedia('(max-aspect-ratio: 3/5)').matches;
    const isIosApp = document.documentElement.classList.contains('iosapp');

    let pixelRatio;
    if (isIosApp || isMobile) {
        // 9:16 zone is limited by whichever dimension is the bottleneck
        const zoneWidth = Math.min(rect.width, rect.height * 9 / 16);
        pixelRatio = 1080 / zoneWidth;
    } else {
        pixelRatio = 1920 / rect.height;
    }

    const fontEmbedCSS = await _buildFontEmbedCSS();
    let dataUrl = await htmlToImage.toPng(slideEl, { pixelRatio, fontEmbedCSS, cacheBust: true });

    if (isIosApp || isMobile) {
        const img = new Image();
        img.src = dataUrl;
        await new Promise(r => { img.onload = r; });
        const canvas = document.createElement('canvas');
        canvas.width = 1080;
        canvas.height = 1920;
        const ctx = canvas.getContext('2d');
        // Center-crop both axes to strip extended bg margins on either side
        const srcX = Math.max(0, Math.round((img.width - 1080) / 2));
        const srcY = Math.max(0, Math.round((img.height - 1920) / 2));
        ctx.drawImage(img, srcX, srcY, 1080, 1920, 0, 0, 1080, 1920);
        dataUrl = canvas.toDataURL('image/png');
    }
    return dataUrl;
}

async function _downloadCurrentSlide() {
    const btn = document.getElementById('download-btn');
    if (!btn || btn.disabled) return;
    btn.disabled = true;

    snapCurrent();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const slideEl = document.getElementById(slide_ids[cur_slide]);
    try {
        const dataUrl = await _captureSlide1080x1920(slideEl);
        const a = document.createElement('a');
        a.download = `pinewood-recap-slide${cur_slide + 1}.png`;
        a.href = dataUrl;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    } catch (err) {
        console.error('Slide download failed:', err);
    } finally {
        btn.disabled = false;
    }
}

document.getElementById('download-btn').addEventListener('click', _downloadCurrentSlide);

async function captureSlideForIOS() {
    if (!window.webkit?.messageHandlers?.slideCapture) return;
    snapCurrent();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const slideEl = document.getElementById(slide_ids[cur_slide]);
    try {
        const dataUrl = await _captureSlide1080x1920(slideEl);
        window.webkit.messageHandlers.slideCapture.postMessage(dataUrl);
    } catch (err) {
        console.error('iOS slide capture failed:', err);
        window.webkit.messageHandlers.slideCapture.postMessage(null);
    }
}

function next_slide() { go_to_slide(cur_slide + 1); }
function prev_slide() { go_to_slide(cur_slide - 1); }
const _activitySnap = {};
const _activityAnimating = {};
let _senioritis_snap = false;
let _senioritis_animating = false;

function isAnimating() {
    const id = slide_ids[cur_slide];
    if (id === 'slide1') return slide1Animating;
    if (id === 'slide2') return slide2Animating;
    if (id === 'slide3') return slide3Animating;
    if (id === 'slide4') return slide4Animating;
    if (id === 'slide-senioritis') return _senioritis_animating;
    if (id.startsWith('slide-activity-')) return !!_activityAnimating[id];
    return false;
}
function snapCurrent() {
    const id = slide_ids[cur_slide];
    if (id === 'slide1') snap_slide1();
    else if (id === 'slide2') slide2Snap = true;
    else if (id === 'slide3') slide3Snap = true;
    else if (id === 'slide4') slide4Snap = true;
    else if (id === 'slide-senioritis') _senioritis_snap = true;
    else if (id.startsWith('slide-activity-')) _activitySnap[id] = true;
}
function forward()  { if (isAnimating()) { snapCurrent(); } else { next_slide(); } }
function backward() { if (isAnimating()) { snapCurrent(); } else { prev_slide(); } }

document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") forward();
    if (e.key === "ArrowLeft"  || e.key === "ArrowUp")   backward();
});

document.addEventListener("click", (e) => { if (!e.target.closest("a") && !e.target.closest("#download-btn")) forward(); });

let _touch_start_x = null;
let _suppressSwipe = false;
document.addEventListener("touchstart", (e) => { _touch_start_x = e.touches[0].clientX; _suppressSwipe = false; }, { passive: true, capture: true });
document.addEventListener("touchend", (e) => {
    if (_touch_start_x === null || _suppressSwipe) { _touch_start_x = null; _suppressSwipe = false; return; }
    const dx = e.changedTouches[0].clientX - _touch_start_x;
    if (Math.abs(dx) > 40) { dx < 0 ? forward() : backward(); }
    _touch_start_x = null;
}, { passive: true });

function make_things_bounce() {document.querySelectorAll(".cas-bounce").forEach((el) => {
    const text = el.textContent;
    el.innerHTML = "";
    document.querySelector(".slide-1-hero p").style.opacity = 1;

    const chars = [];
    let charIndex = 0;

    for (const ch of text) {
        if (ch === " ") {
            el.appendChild(document.createTextNode(" "));
        } else {
            const span = document.createElement("span");
            span.textContent = ch;
            span.style.cssText = "display:inline-block; will-change:transform,filter;";
            span.dataset.charIndex = charIndex++;
            el.appendChild(span);
            chars.push(span);
        }
    }

    const INTERVAL = 3000;
    const OFFSET = 80;

    chars.forEach((span, i) => {
        setTimeout(() => {
            const bounce = () => {
                span.style.animation = "none";
                span.offsetHeight; // force reflow
                span.style.animation = "cas-char-bounce 0.6s cubic-bezier(0.36, 0.07, 0.19, 0.97) forwards";
            };
            bounce();
            setInterval(bounce, INTERVAL);
        }, i * OFFSET);
    });
});}

function reset_slide1() {
    const el = document.getElementById("txt-to-fade-in");
    el.innerHTML = "Your Recap";
    document.querySelectorAll(".cas-bounce").forEach((bounce_el) => {
        bounce_el.innerHTML = bounce_el.textContent;
    });
    document.querySelector(".slide-1-hero p").style.opacity = "";
}

function make_title_animate() {
slide1Animating = true;
slide1Snap = false;
_slide1Timeouts = [];
let the_title_thing = document.getElementById("txt-to-fade-in");

const text = the_title_thing.textContent;
the_title_thing.innerHTML = "";

const chars = [];
let charIndex = 0;

for (const ch of text) {
    if (ch === " ") {
        the_title_thing.appendChild(document.createElement("br"));
    } else {
        const span = document.createElement("span");
        span.textContent = ch;
        span.style.cssText = "display:inline-block; will-change:transform,filter; opacity: 0";
        span.dataset.charIndex = charIndex++;
        the_title_thing.appendChild(span);
        chars.push(span);
    }
}

let OFFSET = 80;

chars.forEach((span, i) => {
    _slide1Timeouts.push(setTimeout(() => {
        if (slide1Snap) return;
        span.style.animation = "none";
        span.offsetHeight; // force reflow
        span.style.animation = "title-text-fade-in 0.6s cubic-bezier(0.36, 0.07, 0.19, 0.97) forwards";
    }, i * OFFSET));
});
_slide1Timeouts.push(setTimeout(() => {
    if (!slide1Snap) make_things_bounce();
    slide1Animating = false;
}, OFFSET * chars.length));
}

function snap_slide1() {
    slide1Snap = true;
    _slide1Timeouts.forEach(t => clearTimeout(t));
    _slide1Timeouts = [];
    document.querySelectorAll('#txt-to-fade-in span').forEach(span => {
        span.style.cssText = 'display:inline-block; will-change:transform,filter; opacity: 1; font-weight: 700;';
    });
    make_things_bounce();
    slide1Animating = false;
}

// ── Contribution graph ────────────────────────────────────────────────────

function _cgFmt(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/**
 * Render a GitHub-style contribution graph into `container`.
 * @param {HTMLElement} container
 * @param {Object} dailyCounts  — keys are "YYYY-MM-DD", values are raw assignment counts
 *
 * Grid covers Jan 7 – May 19 2026. Cells outside that range are hidden.
 * Levels are computed from percentile thresholds of all non-zero days:
 *   0 = none, 1 = ≤p25, 2 = ≤p50, 3 = ≤p75, 4 = top 25%
 */
function buildContribGraph(container, dailyCounts, mode) {
    const START = new Date(2026, 0, 7);   // Jan  7 (Wed)
    const END   = new Date(2026, 4, 19);  // May 19 (Tue)

    // Snap grid left edge to the Sunday on/before START
    const gridStart = new Date(START);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());

    // Collect non-zero day counts for percentile thresholds
    const vals = [];
    for (let _d = new Date(START); _d <= END; _d.setDate(_d.getDate() + 1)) {
        const v = dailyCounts[_cgFmt(_d)] || 0;
        if (v > 0) vals.push(v);
    }
    vals.sort((a, b) => a - b);

    const pv = (p) => vals.length ? vals[Math.min(Math.floor(p * vals.length), vals.length - 1)] : 0;
    const [p33, p60, p90] = [pv(0.33), pv(0.60), pv(0.90)];

    const lvl = (v) => {
        if (v === 0) return 0;
        if (v < p33) return 1;
        if (v < p60) return 2;
        if (v < p90) return 3;
        return 4;
    };

    container.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'cg-grid';

    const MONTHS = ['Jan','Feb','Mar','Apr','May'];
    let firstCol = true;

    for (let w = new Date(gridStart); w <= END; w.setDate(w.getDate() + 7)) {
        const col = document.createElement('div');
        col.className = 'cg-col';

        const lbl = document.createElement('div');
        lbl.className = 'cg-month';
        if (firstCol) {
            // Grid starts mid-January; anchor "Jan" to the first column
            lbl.textContent = 'Jan';
            firstCol = false;
        } else {
            // Show a month label on whichever column contains the 1st of that month
            for (let r = 0; r < 7; r++) {
                const cd = new Date(w);
                cd.setDate(cd.getDate() + r);
                if (cd.getDate() === 1) { lbl.textContent = MONTHS[cd.getMonth()] || ''; break; }
            }
        }
        col.appendChild(lbl);

        for (let row = 0; row < 7; row++) {
            const cd = new Date(w);
            cd.setDate(cd.getDate() + row);
            const cell = document.createElement('div');
            if (cd < START || cd > END) {
                cell.className = 'cg-cell cg-empty';
            } else {
                const key = _cgFmt(cd);
                const v = dailyCounts[key] || 0;
                const level = lvl(v);
                const verb = mode === 'teacher' ? 'graded' : 'completed';
                cell.className = `cg-cell cg-l${level}`;
                cell.title = `${key}: ${v} assignment${v !== 1 ? 's' : ''} ${verb}`;
                cell.dataset.date = key;
                cell.dataset.count = String(v);
            }
            col.appendChild(cell);
        }

        grid.appendChild(col);
    }

    container.appendChild(grid);
}

function fmtStreakDate(iso) {
    const [, m, d] = iso.split('-').map(Number);
    return `${m}/${d}`;
}

function epochToPSTDate(epochSec) {
    return new Date(epochSec * 1000)
        .toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}
function epochToPSTHour(epochSec) {
    return parseInt(new Date(epochSec * 1000)
        .toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }));
}

function formatDaysAfterDue(days) {
    if (days < 2) return `Finished grading ${days} day after due`;
    if (days < 7) return `Finished grading ${days} days after due`;
    const weeks = Math.round(days / 7);
    if (days < 30) return `Finished grading ~${weeks} week${weeks === 1 ? '' : 's'} after due`;
    const months = Math.round(days / 30);
    if (days < 365) return `Finished grading ~${months} month${months === 1 ? '' : 's'} after due`;
    const years = Math.round(days / 365);
    return `Finished grading ~${years} year${years === 1 ? '' : 's'} after due`;
}

const _MONTH_NAMES = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];

const RANGE_START = '2026-01-07';
const RANGE_END   = '2026-05-19';

function computeRecapStats(raw) {
    const dailyCounts = {};
    const monthCounts = {};
    const hourlyCounts = new Array(24).fill(0);
    let total = 0;
    for (const course of raw.assignments || []) {
        for (const ev of course.data || []) {
            const t = ev.t;
            const dateKey = epochToPSTDate(t); // YYYY-MM-DD
            if (dateKey < RANGE_START || dateKey > RANGE_END) continue;
            total += 1;
            dailyCounts[dateKey] = (dailyCounts[dateKey] || 0) + 1;
            const monthIdx = parseInt(dateKey.slice(5, 7), 10) - 1;
            const monthName = _MONTH_NAMES[monthIdx];
            monthCounts[monthName] = (monthCounts[monthName] || 0) + 1;
            const hour = epochToPSTHour(t) % 24;
            hourlyCounts[hour]++;
        }
    }

    let busiest_month = '';
    let busiest_month_count = 0;
    for (const [m, c] of Object.entries(monthCounts)) {
        if (c > busiest_month_count) { busiest_month = m; busiest_month_count = c; }
    }

    let busiest_day_key = '';
    let busiest_day_count = 0;
    for (const [d, c] of Object.entries(dailyCounts)) {
        if (c > busiest_day_count) { busiest_day_key = d; busiest_day_count = c; }
    }
    let busiest_day = '';
    if (busiest_day_key) {
        const m = parseInt(busiest_day_key.slice(5, 7), 10);
        const d = parseInt(busiest_day_key.slice(8, 10), 10);
        busiest_day = `${m}/${d}`;
    }

    let totalSecBeforeDue = 0;
    let dueCount = 0;
    for (const course of raw.assignments || []) {
        for (const ev of course.data || []) {
            const dateKey = epochToPSTDate(ev.t);
            if (dateKey < RANGE_START || dateKey > RANGE_END) continue;
            if (ev.due) {
                totalSecBeforeDue += ev.due - ev.t;
                dueCount++;
            }
        }
    }
    const avg_sec_before_due = dueCount > 0 ? Math.round(totalSecBeforeDue / dueCount) : null;

    // Longest consecutive streak of days with at least one submission
    let streak = 0, streakStart = '', streakEnd = '';
    {
        let cur = 0, curStart = '';
        for (let d = new Date(RANGE_START + 'T12:00:00Z'); ; d.setUTCDate(d.getUTCDate() + 1)) {
            const key = d.toISOString().slice(0, 10);
            if (key > RANGE_END) break;
            if (dailyCounts[key]) {
                if (cur === 0) curStart = key;
                cur++;
                if (cur > streak) { streak = cur; streakStart = curStart; streakEnd = key; }
            } else {
                cur = 0; curStart = '';
            }
        }
    }

    let peak_hour = 0;
    for (let h = 1; h < 24; h++) {
        if (hourlyCounts[h] > hourlyCounts[peak_hour]) peak_hour = h;
    }
    const late_count = hourlyCounts[22] + hourlyCounts[23]
        + hourlyCounts[0] + hourlyCounts[1] + hourlyCounts[2]
        + hourlyCounts[3] + hourlyCounts[4] + hourlyCounts[5];
    const late_pct = total > 0 ? Math.round(late_count / total * 100) : 0;

    const top_courses = raw.mode === 'student'
        ? Object.entries(
            (raw.assignments || []).reduce((acc, c) => {
                const inRange = (c.data || []).filter(ev => {
                    const dk = epochToPSTDate(ev.t);
                    return dk >= RANGE_START && dk <= RANGE_END;
                });
                acc[c.course] = (acc[c.course] || 0) + inRange.length;
                return acc;
            }, {})
          ).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([course, count]) => ({ course, count }))
        : [];

    return {
        mode: raw.mode,
        user_name: raw.user_name,
        total_assignments: total,
        busiest_month,
        busiest_month_count,
        busiest_day,
        busiest_day_count,
        dailyCounts,
        top_courses,
        top_slow_graded: raw.top_slow_graded || [],
        peak_hour,
        late_count,
        late_pct,
        hourlyCounts,
        streak,
        streakStart,
        streakEnd,
        avg_sec_before_due,
    };
}

const _ROBOTICS_LOGO_HTML = `<!doctypehtml><style>body{margin:0}svg{display:block;width:100vw;height:100vh}.draw{fill:none;stroke:#70ce35;stroke-linecap:round;stroke-miterlimit:10}</style><body><svg style=visibility:hidden viewBox="0 0 116.21 155.5"><g><path class=draw d=M91.63,61.53c9.58,8.96,15.57,21.72,15.57,35.87c0,27.12,-21.98,49.1,-49.1,49.1c-27.12,0,-49.1,-21.98,-49.1,-49.1c0,-14.15,5.99,-26.91,15.57,-35.87 id=U /><line class=draw id=I x1=58.1 x2=58.1 y1=97.4 y2=9 /><line class=draw id=L x1=58.1 x2=84.16 y1=9 y2=35.06 /><line class=draw id=J x1=58.1 x2=32.04 y1=9 y2=35.06 /></g></svg><script src=https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js></script><script>let p=new URLSearchParams(location.search),S=+(p.get("s")||1),bg=p.get("bg"),q=t=>document.getElementById(t),U=q("U"),I=q("I"),L=q("L"),J=q("J"),LJ=[L,J],sw="stroke-width",at="attr",gl="getTotalLength";bg&&"none"!==bg&&(document.body.style.background="#"+bg),[U,I,L,J].forEach(t=>{var e=t[gl]();t.style.strokeDasharray=e,t.style.strokeDashoffset=e}),document.querySelector("svg").style.visibility="";let tl=gsap.timeline();gsap.set(LJ,{[at]:{[sw]:0}},0),tl.fromTo(U,{[at]:{[sw]:0}},{[at]:{[sw]:18},duration:.2/S,ease:"power2.out"},0),tl.to(U,{strokeDashoffset:0,duration:1.1/S,ease:"power3.out"},0),tl.fromTo(I,{[at]:{[sw]:0}},{[at]:{[sw]:18},duration:.2/S,ease:"power2.out"},.25/S),tl.to(I,{strokeDashoffset:0,duration:.5/S},.25/S),tl.set(LJ,{[at]:{[sw]:18}},.7/S),tl.to(LJ,{strokeDashoffset:0,duration:.6/S,ease:"power3.out"},.7/S)<\/script>`;
function _roboticsLogoSrc(speed) {
    const html = _ROBOTICS_LOGO_HTML.replace('p.get("s")||1', `p.get("s")||${speed}`);
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function _playRoboticsLogo(idx, snapped) {
    const iframe = document.getElementById(`rob-iframe-${idx}`);
    if (!iframe) return;
    iframe.src = _roboticsLogoSrc(snapped ? 999 : 1);
}

async function _animateActivitySlide(id, nameEl, captionEl, isRobotics, robIdx) {
    _activityAnimating[id] = true;

    const snap = () => _activitySnap[id];
    const alive = () => slide_ids[cur_slide] === id;

    captionEl.style.transition = '';
    captionEl.style.opacity = '0';

    if (isRobotics) _playRoboticsLogo(robIdx, snap());

    const seasonWord = nameEl.dataset.seasonWord;
    const season     = nameEl.dataset.season;
    const rest       = nameEl.dataset.rest;

    if (seasonWord) {
        // Pre-render structure so color is present from character 1
        nameEl.innerHTML = `<span class="activity-season-word activity-season-${season}"></span><br><span class="act-rest"></span>`;
        const swEl   = nameEl.querySelector('.activity-season-word');
        const restEl = nameEl.querySelector('.act-rest');
        await typewriter(swEl, seasonWord, 45, null, alive, snap);
        if (!alive()) { _activityAnimating[id] = false; return; }
        await typewriter(restEl, rest, 45, null, alive, snap);
    } else {
        nameEl.innerHTML = '';
        await typewriter(nameEl, nameEl.dataset.text || '', 45, null, alive, snap);
    }

    if (!alive()) { _activityAnimating[id] = false; return; }

    if (isRobotics && snap()) _playRoboticsLogo(robIdx, true);

    captionEl.style.transition = 'opacity 0.4s';
    captionEl.style.opacity = '1';

    _activityAnimating[id] = false;
}

function _senioritis_color(pct) {
    // green (#22c55e) → amber (#f0b93a) → red (#ef4444)
    if (pct <= 0.5) {
        const t = pct * 2;
        return `rgb(${Math.round(34+206*t)},${Math.round(197-12*t)},${Math.round(94-36*t)})`;
    }
    const t = (pct - 0.5) * 2;
    return `rgb(${Math.round(240-1*t)},${Math.round(185-117*t)},${Math.round(58+10*t)})`;
}

function _buildSenioritis(senioritis) {
    if (!senioritis) return;
    const slidesContainer = document.querySelector('#main-recap-container .slides');
    if (!slidesContainer) return;

    const el = document.createElement('div');
    el.id = 'slide-senioritis';
    el.className = 'slide-base';
    el.style.display = 'none';
    el.innerHTML = `
        <div class="s2cont">
            <div>
                <p class="sen-eyebrow" id="sen-eyebrow" style="opacity:0">SENIORITIS INDEX</p>
                <div class="sen-score-row">
                    <span class="sen-score" id="sen-score">0</span>
                    <span class="sen-max">/100</span>
                </div>
                <div class="sen-bar-track">
                    <div class="sen-bar-fill" id="sen-bar-fill"></div>
                </div>
                <p class="sen-label" id="sen-label"></p>
                <div class="sen-stats" id="sen-stats" style="opacity:0"></div>
            </div>
        </div>
    `;

    // Insert in DOM after slide4, before any activity slides
    const slide4El = document.getElementById('slide4');
    if (slide4El && slide4El.nextSibling) {
        slidesContainer.insertBefore(el, slide4El.nextSibling);
    } else {
        slidesContainer.appendChild(el);
    }
    // Insert into slide_ids at position 4 (after slide4, before activity slides)
    slide_ids.splice(4, 0, 'slide-senioritis');

    const TIERS = [
        [0,  20, 'Bro was locked in'],
        [21, 40, 'Slightly slacked off a bit'],
        [41, 60, 'Cooked™'],
        [61, 80, 'Bro is getting rescinded'],
        [81, 100, 'Did you even come to school?'],
    ];
    const getTierLabel = s => (TIERS.find(([lo, hi]) => s <= hi) || TIERS[TIERS.length-1])[2];

    function _animateSenBar(fillEl, scoreEl, target, alive, snapFn) {
        const DURATION = 1400;
        if (snapFn()) {
            const c = _senioritis_color(target / 100);
            fillEl.style.width = `${target}%`;
            fillEl.style.background = c;
            fillEl.style.boxShadow = `0 0 10px ${c}88`;
            scoreEl.textContent = target;
            scoreEl.style.color = c;
            return Promise.resolve();
        }
        return new Promise(resolve => {
            const t0 = Date.now();
            const step = () => {
                if (!alive()) { resolve(); return; }
                if (snapFn()) {
                    const c = _senioritis_color(target / 100);
                    fillEl.style.width = `${target}%`;
                    fillEl.style.background = c;
                    fillEl.style.boxShadow = `0 0 10px ${c}88`;
                    scoreEl.textContent = target;
                    scoreEl.style.color = c;
                    resolve(); return;
                }
                const p = Math.min((Date.now() - t0) / DURATION, 1);
                const e = 1 - Math.pow(1 - p, 3);
                const cur = Math.round(e * target);
                const c = _senioritis_color(cur / 100);
                fillEl.style.width = `${cur}%`;
                fillEl.style.background = c;
                fillEl.style.boxShadow = `0 0 10px ${c}66`;
                scoreEl.textContent = cur;
                scoreEl.style.color = c;
                if (p < 1) requestAnimationFrame(step);
                else {
                    fillEl.style.width = `${target}%`;
                    scoreEl.textContent = target;
                    resolve();
                }
            };
            requestAnimationFrame(step);
        });
    }

    slide_on_enter['slide-senioritis'] = async () => {
        _senioritis_snap = false;
        _senioritis_animating = true;
        const snap = () => _senioritis_snap;
        const alive = () => slide_ids[cur_slide] === 'slide-senioritis';

        if (!RECAP_DATA) await dataReady;
        if (!alive()) { _senioritis_animating = false; return; }

        // Pre-render stats invisible so layout is reserved before animations start
        const statsEl = document.getElementById('sen-stats');
        const statLines = [];
        if (senioritis.missing > 0)
            statLines.push(`${senioritis.missing} assignment${senioritis.missing !== 1 ? 's' : ''} never submitted`);
        if (senioritis.late > 0)
            statLines.push(`${senioritis.late} late submission${senioritis.late !== 1 ? 's' : ''}`);
        if (senioritis.last_minute > 0)
            statLines.push(`${senioritis.last_minute} last-minute submission${senioritis.last_minute !== 1 ? 's' : ''}`);
        if (statLines.length) {
            statsEl.innerHTML = statLines.map(t =>
                `<div class="sen-stat-item" style="opacity:0;transform:translateX(-10px)">${t}</div>`
            ).join('');
            statsEl.style.opacity = '1';
        }

        const eyebrow = document.getElementById('sen-eyebrow');
        eyebrow.style.transition = snap() ? 'none' : 'opacity 0.5s';
        eyebrow.style.opacity = '1';

        await delay(snap() ? 0 : 350, alive, snap);
        if (!alive()) { _senioritis_animating = false; return; }

        await _animateSenBar(
            document.getElementById('sen-bar-fill'),
            document.getElementById('sen-score'),
            senioritis.score, alive, snap
        );
        if (!alive()) { _senioritis_animating = false; return; }

        await delay(snap() ? 0 : 250, alive, snap);
        if (!alive()) { _senioritis_animating = false; return; }

        await typewriter(document.getElementById('sen-label'), getTierLabel(senioritis.score), 38, null, alive, snap);
        if (!alive()) { _senioritis_animating = false; return; }

        await delay(snap() ? 0 : 150, alive, snap);
        if (!alive()) { _senioritis_animating = false; return; }

        for (const item of statsEl.querySelectorAll('.sen-stat-item')) {
            if (!alive()) { _senioritis_animating = false; return; }
            if (snap()) {
                item.style.transition = 'none';
                item.style.opacity = '1';
                item.style.transform = 'translateX(0)';
            } else {
                item.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                item.style.opacity = '1';
                item.style.transform = 'translateX(0)';
                await delay(200, alive, snap);
            }
        }

        _senioritis_animating = false;
    };

    slide_on_exit['slide-senioritis'] = () => {
        _senioritis_animating = false;
        _senioritis_snap = false;
        const eyebrow = document.getElementById('sen-eyebrow');
        if (eyebrow) { eyebrow.style.transition = 'none'; eyebrow.style.opacity = '0'; }
        const fillEl = document.getElementById('sen-bar-fill');
        if (fillEl) { fillEl.style.width = '0%'; fillEl.style.background = '#22c55e'; fillEl.style.boxShadow = ''; }
        const scoreEl = document.getElementById('sen-score');
        if (scoreEl) { scoreEl.textContent = '0'; scoreEl.style.color = ''; }
        const labelEl = document.getElementById('sen-label');
        if (labelEl) labelEl.textContent = '';
        const statsEl = document.getElementById('sen-stats');
        if (statsEl) { statsEl.style.opacity = '0'; statsEl.innerHTML = ''; }
    };
}

function _buildActivitySlides(activities) {
    if (!activities || !activities.length) return;
    const slidesContainer = document.querySelector('#main-recap-container .slides');
    if (!slidesContainer) return;

    const SEASON_LABELS = { fall: 'Fall', winter: 'Winter', spring: 'Spring' };

    activities.forEach((act, i) => {
        const d = act.dat;
        const id = `slide-activity-${i}`;
        const el = document.createElement('div');
        el.id = id;
        el.style.display = 'none';

        const bgPos = d.face_pos ? `${d.face_pos.x}% ${d.face_pos.y}%` : 'center 30%';

        if (act.type === 'sport') {
            el.className = 'slide-base slide-activity' + (d.l_d === 'light' ? ' activity-light' : '');
            const seasonLabel = SEASON_LABELS[d.season] || d.season;
            el.innerHTML = `
                <div class="activity-bg" style="background-image:url('${d.image_url}');background-position:${bgPos}"></div>
                <div class="activity-gradient"></div>
                <div class="activity-content">
                    <p class="activity-category" style="opacity:0"><span class="activity-season-word activity-season-${d.season}">${seasonLabel}</span> Sport</p>
                    <h1 class="activity-name" data-text="${d.sport}"></h1>
                </div>
            `;
        } else if (act.type === 'performing_arts') {
            el.className = 'slide-base slide-activity' + (d.l_d === 'light' ? ' activity-light' : '');
            const [seasonWord, ...restWords] = d.label.split(' ');
            const restLabel = restWords.join(' ');
            // Typewriter runs on plain text; color span re-applied after via data attributes
            el.innerHTML = `
                <div class="activity-bg" style="background-image:url('${d.image_url}');background-position:${bgPos}"></div>
                <div class="activity-gradient"></div>
                <div class="activity-content">
                    <p class="activity-category" style="opacity:0">Performing Arts</p>
                    <h1 class="activity-name" data-text="${d.label}" data-season="${d.season}" data-season-word="${seasonWord}" data-rest="${restLabel}"></h1>
                </div>
            `;
        } else if (act.type === 'robotics') {
            el.className = 'slide-base slide-activity';
            el.innerHTML = `
                <div class="activity-bg" style="background-image:url('${d.image_url}');background-position:${bgPos}"></div>
                <div class="activity-gradient"></div>
                <div class="activity-robotics-logo">
                    <iframe id="rob-iframe-${i}" src="" style="width:100%;height:100%;border:none;background:transparent;" scrolling="no"></iframe>
                </div>
                <div class="activity-content">
                    <p class="activity-robotics-quote" style="opacity:0">"Wait, Pinewood has a robotics team?"</p>
                    <h1 class="activity-name" data-text="Robotics"></h1>
                </div>
            `;
        } else {
            return;
        }

        slidesContainer.appendChild(el);
        slide_ids.push(id);

        // Wire up animation
        const nameEl    = el.querySelector('.activity-name');
        const captionEl = el.querySelector('.activity-category, .activity-robotics-quote');
        const isRob     = act.type === 'robotics';
        const robIdx    = i;

        // For performing_arts, typewriter runs on plain text then we re-render with colored span
        const _onEnter = () => {
            _activitySnap[id] = false;
            const rawText = nameEl.dataset.text || '';
            const doAnim = async () => {
                await _animateActivitySlide(id, nameEl, captionEl, isRob, robIdx);
            };
            doAnim();
        };
        slide_on_enter[id] = _onEnter;
        slide_on_exit[id]  = () => { _activityAnimating[id] = false; _activitySnap[id] = false; };
    });
}

async function initRecapData() {
    let json = null;
    const cacheKey = 'recap_cache_' + RECAP_ID;
    try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) json = JSON.parse(cached);
    } catch(e) {}
    if (!json) {
        const resp = await fetch(`/api/recap/${RECAP_ID}`);
        json = await resp.json();
    }
    RECAP_DATA = computeRecapStats(json.slides);
    _buildSenioritis(json.slides.senioritis || null);
    _buildActivitySlides(json.slides.activities || []);
    slide_ids.push('slide-thanks');
    slide_on_enter['slide-thanks'] = () => {
        const hero = document.querySelector('#slide-thanks .slide-thanks-hero');
        if (!hero) return;
        hero.style.transition = 'none';
        hero.style.opacity = '0';
        requestAnimationFrame(() => {
            hero.style.transition = 'opacity 0.7s ease';
            hero.style.opacity = '1';
        });
    };
    slide_on_exit['slide-thanks'] = () => {
        const hero = document.querySelector('#slide-thanks .slide-thanks-hero');
        if (hero) { hero.style.transition = 'none'; hero.style.opacity = '0'; }
    };
    _dataReadyResolve();
    const cgEl = document.getElementById('s2-graph');
    if (cgEl) {
        buildContribGraph(cgEl, RECAP_DATA.dailyCounts, RECAP_DATA.mode);
        attachGraphInteraction(cgEl, RECAP_DATA.mode);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Slide animation utilities

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS_IN_MONTH = [31,28,31,30,31,30,31,31,30,31,30,31];

function monthCountUpOptions(targetMonthName, n = 10) {
    const endIdx = MONTHS.indexOf(targetMonthName);
    const options = [];
    for (let i = n; i >= 1; i--) {
        options.push(MONTHS[(endIdx - i + 120) % 12]);
    }
    return options;
}

function dateCountUpOptions(targetDateStr, n = 10) {
    const [tm, td] = targetDateStr.split('/').map(Number);
    const options = [];
    for (let i = n; i >= 1; i--) {
        let m = tm - i;
        let d = td - i;
        while (m < 1) m += 12;
        d = Math.max(1, Math.min(d, DAYS_IN_MONTH[m - 1]));
        options.push(`${m}/${d}`);
    }
    return options;
}

function delay(ms, alive, snapFn = () => false) {
    if (snapFn() || (alive && !alive())) return Promise.resolve();
    return new Promise(resolve => {
        const end = Date.now() + ms;
        const tick = setInterval(() => {
            if (snapFn() || (alive && !alive()) || Date.now() >= end) {
                clearInterval(tick);
                resolve();
            }
        }, 16);
    });
}

function typewriter(el, text, msPerChar, ncEl, alive, snapFn = () => false) {
    el.innerHTML = '';
    if (snapFn()) { el.textContent = text; if (ncEl) updateNotecard(ncEl); return Promise.resolve(); }
    return new Promise(resolve => {
        let i = 0;
        const tick = setInterval(() => {
            if (alive && !alive()) { clearInterval(tick); resolve(); return; }
            if (snapFn()) { el.textContent = text; if (ncEl) updateNotecard(ncEl); clearInterval(tick); resolve(); return; }
            const span = document.createElement('span');
            span.textContent = text[i++];
            span.style.cssText = 'display:inline; opacity:0; animation:char-fade-in 0.3s forwards;';
            el.appendChild(span);
            if (ncEl) updateNotecard(ncEl);
            if (i >= text.length) { clearInterval(tick); resolve(); }
        }, msPerChar);
    });
}

function countUp(el, from, to, durationMs, ncEl, alive, snapFn = () => false, suffix = '') {
    if (snapFn()) { el.textContent = to + suffix; if (ncEl) updateNotecard(ncEl); return Promise.resolve(); }
    return new Promise(resolve => {
        const startTime = Date.now();
        const step = () => {
            if (alive && !alive()) { resolve(); return; }
            if (snapFn()) { el.textContent = to + suffix; if (ncEl) updateNotecard(ncEl); resolve(); return; }
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / durationMs, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            el.textContent = Math.round(from + (to - from) * eased) + suffix;
            if (ncEl) updateNotecard(ncEl);
            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                el.textContent = to + suffix;
                if (ncEl) updateNotecard(ncEl);
                resolve();
            }
        };
        requestAnimationFrame(step);
    });
}

function animatePaperclip(durationMs, alive, snapFn = () => false) {
    return new Promise(resolve => {
        const fullClip = document.querySelector('.s2-clip-full');
        const topClip = document.querySelector('.s2-clip-top');
        if (!fullClip || !topClip) { resolve(); return; }

        const startAngle = parseFloat(fullClip.dataset.startAngle || 0);
        const startX = parseFloat(fullClip.dataset.startX || 0);
        const startY = parseFloat(fullClip.dataset.startY || 0);

        const paper = document.querySelector('.s2-graph-paper-bg');
        const rect = paper.getBoundingClientRect();
        const w = rect.width / 2;
        const h = rect.height / 2;

        const directions = [
            { angle: 0, x: w, y: 0 },         // right
            { angle: 45, x: w, y: h },        // bottom-right
            { angle: 90, x: 0, y: h },        // bottom
            { angle: 135, x: -w, y: h },      // bottom-left
            { angle: 180, x: -w, y: 0 },      // left
            { angle: 225, x: -w, y: -h },     // top-left
            { angle: 270, x: 0, y: -h },      // top
            { angle: 315, x: w, y: -h },      // top-right
        ];

        const startDir = Math.atan2(startY, startX) * 180 / Math.PI;
        let closest = directions[0];
        let minDiff = 360;
        for (const dir of directions) {
            let diff = Math.abs(dir.angle - startDir);
            if (diff > 180) diff = 360 - diff;
            if (diff < minDiff) {
                minDiff = diff;
                closest = dir;
            }
        }

        const finalX = closest.x * 0.6;
        const finalY = closest.y * 0.6;
        const finalAngle = closest.angle + 270;

        const startTime = Date.now();
        const step = () => {
            if (alive && !alive()) { resolve(); return; }
            if (snapFn()) {
                fullClip.style.transform = `translate(calc(-50% + ${finalX}px), calc(-50% + ${finalY}px)) rotate(${finalAngle}deg)`;
                topClip.style.transform = `translate(calc(-50% + ${finalX}px), calc(-50% + ${finalY}px)) rotate(${finalAngle}deg)`;
                resolve(); return;
            }
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / durationMs, 1);
            const eased = 1 - Math.pow(1 - progress, 2);

            const angle = startAngle + (finalAngle - startAngle) * eased;
            const x = startX + (finalX - startX) * eased;
            const y = startY + (finalY - startY) * eased;

            fullClip.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) rotate(${angle}deg)`;
            topClip.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) rotate(${angle}deg)`;

            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                fullClip.style.transform = `translate(calc(-50% + ${finalX}px), calc(-50% + ${finalY}px)) rotate(${finalAngle}deg)`;
                topClip.style.transform = `translate(calc(-50% + ${finalX}px), calc(-50% + ${finalY}px)) rotate(${finalAngle}deg)`;
                resolve();
            }
        };
        requestAnimationFrame(step);
    });
}

function scrollReveal(el, options, finalText, durationMs, ncEl, alive, snapFn = () => false) {
    if (snapFn()) { el.textContent = finalText; if (ncEl) updateNotecard(ncEl); return Promise.resolve(); }
    return new Promise(resolve => {
        const startTime = Date.now();
        let lastIndex = -1;
        const step = () => {
            if (alive && !alive()) { resolve(); return; }
            if (snapFn()) { el.textContent = finalText; if (ncEl) updateNotecard(ncEl); resolve(); return; }
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / durationMs, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            const currentIndex = Math.floor(eased * options.length);
            if (currentIndex !== lastIndex && currentIndex < options.length) {
                el.textContent = options[currentIndex];
                if (ncEl) updateNotecard(ncEl);
                lastIndex = currentIndex;
            }
            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                el.textContent = finalText;
                if (ncEl) updateNotecard(ncEl);
                resolve();
            }
        };
        requestAnimationFrame(step);
    });
}

// ── Notecard cutout helpers ───────────────────────────────────────────────

function makeNcPolygon() {
    const r = () => ((Math.random() * 0.68) - 0.34).toFixed(2);
    return `polygon(` +
        `calc(0% + ${r()}vh) calc(0% + ${r()}vh),` +
        `calc(100% + ${r()}vh) calc(0% + ${r()}vh),` +
        `calc(100% + ${r()}vh) calc(100% + ${r()}vh),` +
        `calc(0% + ${r()}vh) calc(100% + ${r()}vh))`;
}

function updateNotecard(el) {
    el.style.clipPath = makeNcPolygon();
    el.style.setProperty('--nc-bg-x', `${(Math.random() * 100).toFixed(1)}%`);
    el.style.setProperty('--nc-bg-y', `${(Math.random() * 100).toFixed(1)}%`);
    el.style.setProperty('--nc-rot', `${((Math.random() * 8) - 4).toFixed(2)}deg`);
    el.style.setProperty('--nc-el-rot', `${((Math.random() * 4) - 2).toFixed(2)}deg`);
}

// ── Slide 2 ───────────────────────────────────────────────────────────────────

function initGraphPaper() {
    const bg = document.querySelector('.s2-graph-paper-bg');
    if (!bg) return;

    const posX = (Math.random() * 60 + 20).toFixed(1);
    const posY = (Math.random() * 60 + 20).toFixed(1);
    const rot = ((Math.random() * 8) - 4).toFixed(2);
    const scale = (Math.random() * 0.08 + 1.0).toFixed(2);
    const clip = `
        ${(Math.random() * 5).toFixed(1)}% ${(Math.random() * 5).toFixed(1)}%,
        calc(100% + ${(Math.random() * 5).toFixed(1)}%) ${(Math.random() * 5).toFixed(1)}%,
        calc(100% + ${(Math.random() * 5).toFixed(1)}%) calc(100% + ${(Math.random() * 5).toFixed(1)}%),
        ${(Math.random() * 5).toFixed(1)}% calc(100% + ${(Math.random() * 5).toFixed(1)}%)
    `;

    bg.style.setProperty('--gp-x', `${posX}%`);
    bg.style.setProperty('--gp-y', `${posY}%`);
    bg.style.setProperty('--gp-rot', `${rot}deg`);
    bg.style.setProperty('--gp-scale', scale);
    bg.style.setProperty('--gp-clip', `polygon(${clip})`);
}

function initPaperclip() {
    const fullClip = document.querySelector('.s2-clip-full');
    const topClip = document.querySelector('.s2-clip-top');
    if (!fullClip || !topClip) return;

    const startDist = 150 + Math.random() * 100;
    const startDir = Math.random() * Math.PI * 2;
    const startX = Math.cos(startDir) * startDist;
    const startY = Math.sin(startDir) * startDist;
    const startAngle = startDir * 180 / Math.PI + 270;

    fullClip.dataset.startAngle = startAngle;
    fullClip.dataset.startX = startX;
    fullClip.dataset.startY = startY;

    fullClip.style.transform = `translate(calc(-50% + ${startX}px), calc(-50% + ${startY}px)) rotate(${startAngle}deg)`;
    topClip.style.transform = `translate(calc(-50% + ${startX}px), calc(-50% + ${startY}px)) rotate(${startAngle}deg)`;
}

function reset_slide2() {
    slide2Gen++;
    document.getElementById('s2-you-completed').textContent = '';
    const _c = document.getElementById('s2-count');
    _c.textContent = '0';
    _c.style.visibility = 'hidden';
    document.getElementById('s2-assignments-text').textContent = '';
    document.getElementById('s2-top3-intro').textContent = '';
    const gpBg = document.querySelector('.s2-graph-paper-bg');
    if (gpBg) gpBg.style.opacity = '0';
    document.querySelector('.s2-clip-full').style.opacity = '0';
    document.querySelector('.s2-clip-top').style.opacity = '0';
    initGraphPaper();
    initPaperclip();
    const top3 = document.getElementById('s2-top3');
    if (top3) { top3.style.display = 'none'; top3.innerHTML = ''; }
}

function _reserveNotecardHeights(notecards) {
    for (const { ncId, html } of notecards) {
        const ncEl = document.getElementById(ncId);
        const sizer = ncEl.closest('.nc-sizer');
        ncEl.style.position = 'absolute';
        ncEl.style.top = '0';
        ncEl.style.left = '0';
        if (!sizer.querySelector('.nc-ghost')) {
            const ghost = document.createElement('p');
            ghost.className = ncEl.className + ' nc-ghost';
            ghost.setAttribute('aria-hidden', 'true');
            ghost.style.visibility = 'hidden';
            ghost.style.pointerEvents = 'none';
            ghost.innerHTML = html;
            sizer.appendChild(ghost);
        }
    }
}

async function animate_slide2() {
    slide2Animating = true;
    slide2Snap = false;
    const myGen = slide2Gen;
    if (!RECAP_DATA) await dataReady;
    if (slide2Gen !== myGen) { slide2Animating = false; return; }
    const d = RECAP_DATA;
    const snap = () => slide2Snap;
    const alive = () => slide2Gen === myGen;

if (!alive()) { slide2Animating = false; return; }
    const verb = d.mode === 'teacher' ? 'You graded' : 'You completed';
    await typewriter(document.getElementById('s2-you-completed'), verb, 40, null, alive, snap);

    if (!alive()) { slide2Animating = false; return; }
    const countEl = document.getElementById('s2-count');
    countEl.style.visibility = 'visible';
    document.querySelector('.s2-graph-paper-bg').style.opacity = '1';
    (async () => {
        await delay(500, alive, snap);
        document.querySelector('.s2-clip-full').style.opacity = '1';
        document.querySelector('.s2-clip-top').style.opacity = '1';
        await animatePaperclip(1000, alive, snap);
    })();
    countUp(countEl, 0, d.total_assignments, 1500, null, alive, snap);
    await delay(500, alive, snap);

    if (!alive()) { slide2Animating = false; return; }
    const assignText = d.mode === 'teacher' ? 'submissions this semester.' : 'assignments this semester.';
    await typewriter(document.getElementById('s2-assignments-text'), assignText, 35, null, alive, snap);

    if (!alive()) { slide2Animating = false; return; }
    const listEl = document.getElementById('s2-top3');
    if (listEl) {
        const items = d.mode === 'teacher' ? d.top_slow_graded : d.top_courses;
        if (items && items.length) {
            const introText = d.mode === 'teacher'
                ? 'The assignments that took you the longest to grade were:'
                : 'The courses you had the most submissions in were:';
            await typewriter(document.getElementById('s2-top3-intro'), introText, 20, null, alive, snap);

            if (!alive()) { slide2Animating = false; return; }
            const cards = items.map((item, i) => {
                if (d.mode === 'teacher') {
                    const daysLabel = formatDaysAfterDue(item.days);
                    return `<div class="s2-top3-item" style="opacity:0;transform:translateX(-12px)">
                        <div class="s2-top3-num">${i + 1}</div>
                        <div class="s2-top3-body">
                            <div class="s2-top3-label">${item.assignment}</div>
                            <div class="s2-top3-meta">${item.course}</div>
                            <div class="s2-top3-days">${daysLabel}</div>
                        </div>
                    </div>`;
                } else {
                    return `<div class="s2-top3-item" style="opacity:0;transform:translateX(-12px)">
                        <div class="s2-top3-num">${i + 1}</div>
                        <div class="s2-top3-body">
                            <div class="s2-top3-label">${item.course}</div>
                            <div class="s2-top3-days">${item.count} submissions</div>
                        </div>
                    </div>`;
                }
            }).join('');
            listEl.innerHTML = cards;
            listEl.style.display = 'flex';
            await delay(150, alive, snap);

            for (const el of listEl.querySelectorAll('.s2-top3-item')) {
                if (!alive()) { slide2Animating = false; return; }
                el.style.transition = 'opacity 0.45s ease, transform 0.45s ease';
                el.style.opacity = '1';
                el.style.transform = 'translateX(0)';
                await delay(200, alive, snap);
            }
        }
    }

    slide2Animating = false;
}

function attachGraphInteraction(container, mode) {
    const verb = mode === 'teacher' ? 'graded' : 'completed';
    let isDragging = false;
    let activeCell = null;

    function selectCell(cell) {
        if (!cell || cell.classList.contains('cg-empty') || !cell.dataset.date) return;
        if (activeCell) activeCell.classList.remove('cg-active');
        activeCell = cell;
        cell.classList.add('cg-active');
        const count = parseInt(cell.dataset.count || '0');
        const [y, m, d] = cell.dataset.date.split('-').map(Number);
        const dateLabel = new Date(y, m - 1, d)
            .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        const infoEl = document.getElementById('s2-graph-info');
        infoEl.querySelector('p').textContent =
            `${dateLabel}: ${count} assignment${count !== 1 ? 's' : ''} ${verb}`;
    }

    function cellFromPoint(x, y) {
        const el = document.elementFromPoint(x, y);
        if (el && el.classList.contains('cg-cell')) return el;
        // If we landed in a gap, find the nearest cell within the container
        if (!container.contains(el) && !container.getBoundingClientRect().width) return null;
        const rect = container.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
        let nearest = null, nearestDist = Infinity;
        for (const cell of container.querySelectorAll('.cg-cell:not(.cg-empty)')) {
            const r = cell.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const d = (x - cx) ** 2 + (y - cy) ** 2;
            if (d < nearestDist) { nearestDist = d; nearest = cell; }
        }
        return nearest;
    }

    container.addEventListener('click', (e) => { e.stopPropagation(); });

    container.addEventListener('mousedown', (e) => {
        const cell = e.target.closest('.cg-cell');
        if (!cell) return;
        e.preventDefault();
        e.stopPropagation();
        isDragging = true;
        selectCell(cell);
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        selectCell(cellFromPoint(e.clientX, e.clientY));
    });

    document.addEventListener('mouseup', () => { isDragging = false; });

    container.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        const cell = cellFromPoint(t.clientX, t.clientY);
        if (!cell) return;
        _suppressSwipe = true;
        isDragging = true;
        selectCell(cell);
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const t = e.touches[0];
        selectCell(cellFromPoint(t.clientX, t.clientY));
    }, { passive: true });

    container.addEventListener('touchend', () => { isDragging = false; }, { passive: true });
}

function attachBarInteraction(barsEl, mode) {
    const verb = mode === 'teacher' ? 'graded' : 'submitted';
    let isDragging = false;
    let activeBar = null;

    function selectBar(bar) {
        if (!bar || !bar.dataset.hour) return;
        if (activeBar) activeBar.classList.remove('s4-bar-active');
        activeBar = bar;
        bar.classList.add('s4-bar-active');
        const h = parseInt(bar.dataset.hour);
        const count = parseInt(bar.dataset.count || '0');
        const infoEl = document.getElementById('s4-chart-info');
        infoEl.querySelector('p').textContent =
            `${formatHour(h)}: ${count} assignment${count !== 1 ? 's' : ''} ${verb}`;
    }

    function barFromPoint(x, y) {
        const el = document.elementFromPoint(x, y);
        if (el && el.dataset.hour !== undefined) return el;
        const rect = barsEl.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
        let nearest = null, nearestDist = Infinity;
        for (const bar of barsEl.querySelectorAll('.s4-bar[data-hour]')) {
            const r = bar.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const dist = Math.abs(x - cx);
            if (dist < nearestDist) { nearestDist = dist; nearest = bar; }
        }
        return nearest;
    }

    barsEl.addEventListener('mousedown', (e) => {
        const bar = e.target.closest('.s4-bar');
        if (!bar) return;
        e.preventDefault();
        isDragging = true;
        selectBar(bar);
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        selectBar(barFromPoint(e.clientX, e.clientY));
    });

    document.addEventListener('mouseup', () => { isDragging = false; });

    barsEl.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        const bar = barFromPoint(t.clientX, t.clientY);
        if (!bar) return;
        _suppressSwipe = true;
        isDragging = true;
        selectBar(bar);
    }, { passive: true });

    barsEl.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const t = e.touches[0];
        selectBar(barFromPoint(t.clientX, t.clientY));
    }, { passive: true });

    barsEl.addEventListener('touchend', () => { isDragging = false; }, { passive: true });
}

// ── Slide 3 ───────────────────────────────────────────────────────────────────

function reset_slide3() {
    slide3Gen++;
    const graph = document.getElementById('s2-graph');
    graph.style.animation = 'none';
    graph.style.opacity = '0';
    graph.style.transform = 'translateY(8vh)';
    const graphInfo = document.getElementById('s2-graph-info');
    graphInfo.style.transition = '';
    graphInfo.style.opacity = '0';
    graphInfo.querySelector('p').textContent = 'Click/tap/drag on graph to view more info about a day';
    const streakWrap = document.getElementById('s3-streak-wrap');
    streakWrap.style.transition = '';
    streakWrap.style.opacity = '0';
    ['s2-m-intro','s2-month-name','s2-m-mid','s2-month-count','s2-m-outro',
     's2-d-intro','s2-day-name','s2-d-mid','s2-day-count','s2-d-outro',
     's3-streak-pre','s3-streak-val','s3-streak-days','s3-streak-from-label','s3-streak-from','s3-streak-to-label','s3-streak-to','s3-streak-post'].forEach(id => {
        document.getElementById(id).textContent = '';
    });
}

async function animate_slide3() {
    slide3Animating = true;
    slide3Snap = false;
    const myGen = slide3Gen;
    if (!RECAP_DATA) await dataReady;
    if (slide3Gen !== myGen) { slide3Animating = false; return; }
    const d = RECAP_DATA;
    const snap = () => slide3Snap;
    const alive = () => slide3Gen === myGen;

    if (!alive()) { slide3Animating = false; return; }
    await typewriter(document.getElementById('s2-m-intro'), 'Your busiest month was ', 35, null, alive, snap);

    if (!alive()) { slide3Animating = false; return; }
    scrollReveal(document.getElementById('s2-month-name'), monthCountUpOptions(d.busiest_month), d.busiest_month, 1000, null, alive, snap);
    await delay(200, alive, snap);

    if (!alive()) { slide3Animating = false; return; }
    await typewriter(document.getElementById('s2-m-mid'), d.mode === 'teacher' ? ' during which you graded ' : ' during which you completed ', 35, null, alive, snap);

    if (!alive()) { slide3Animating = false; return; }
    countUp(document.getElementById('s2-month-count'), 0, d.busiest_month_count, 700, null, alive, snap);
    await delay(150, alive, snap);

    if (!alive()) { slide3Animating = false; return; }
    await typewriter(document.getElementById('s2-m-outro'), ' assignments.', 35, null, alive, snap);

    if (!alive()) { slide3Animating = false; return; }
    await delay(100, alive, snap);
    await typewriter(document.getElementById('s2-d-intro'), 'Your busiest day was ', 35, null, alive, snap);

    if (!alive()) { slide3Animating = false; return; }
    scrollReveal(document.getElementById('s2-day-name'), dateCountUpOptions(d.busiest_day), d.busiest_day, 800, null, alive, snap);
    await typewriter(document.getElementById('s2-d-mid'), d.mode === 'teacher' ? ' on which you graded ' : ' on which you did ', 35, null, alive, snap);

    if (!alive()) { slide3Animating = false; return; }
    countUp(document.getElementById('s2-day-count'), 0, d.busiest_day_count, 700, null, alive, snap);
    await delay(150, alive, snap);

    if (!alive()) { slide3Animating = false; return; }
    await typewriter(document.getElementById('s2-d-outro'), ' assignments.', 35, null, alive, snap);

    if (!alive()) { slide3Animating = false; return; }
    const graph = document.getElementById('s2-graph');
    graph.style.opacity = '';
    graph.style.transform = '';
    void graph.offsetHeight;
    graph.style.animation = 'graph-rise 0.7s ease both';
    await delay(700, alive, snap);
    const graphInfo = document.getElementById('s2-graph-info');
    const hasRange = !!(d.streakStart && d.streakEnd);
    function _fillStreak(instantEl) {
        document.getElementById('s3-streak-pre').textContent = 'Your longest streak was ';
        document.getElementById('s3-streak-val').textContent = d.streak;
        document.getElementById('s3-streak-days').textContent = ` day${d.streak !== 1 ? 's' : ''}`;
        document.getElementById('s3-streak-from-label').textContent = hasRange ? ', from ' : '';
        document.getElementById('s3-streak-from').textContent = hasRange ? fmtStreakDate(d.streakStart) : '';
        document.getElementById('s3-streak-to-label').textContent = hasRange ? ' to ' : '';
        document.getElementById('s3-streak-to').textContent = hasRange ? fmtStreakDate(d.streakEnd) : '';
        document.getElementById('s3-streak-post').textContent = '.';
        if (instantEl) { instantEl.style.transition = 'none'; instantEl.style.opacity = '1'; }
    }

    if (snap()) {
        graph.style.animation = 'none'; graph.style.opacity = '1'; graph.style.transform = 'translateY(0)';
        graphInfo.style.transition = 'none';
        graphInfo.style.opacity = '1';
        _fillStreak(document.getElementById('s3-streak-wrap'));
    }

    if (!alive()) { slide3Animating = false; return; }
    graphInfo.style.opacity = '1';

    await delay(400, alive, snap);
    if (!alive()) { slide3Animating = false; return; }

    const streakWrap = document.getElementById('s3-streak-wrap');
    if (snap()) {
        _fillStreak(streakWrap);
    } else {
        streakWrap.style.opacity = '1';
        await typewriter(document.getElementById('s3-streak-pre'), 'Your longest streak was ', 30, null, alive, snap);
        if (!alive()) { slide3Animating = false; return; }
        await countUp(document.getElementById('s3-streak-val'), 0, d.streak, 700, null, alive, snap);
        if (!alive()) { slide3Animating = false; return; }
        await typewriter(document.getElementById('s3-streak-days'), ` day${d.streak !== 1 ? 's' : ''}`, 40, null, alive, snap);
        if (!alive()) { slide3Animating = false; return; }
        if (hasRange) {
            await typewriter(document.getElementById('s3-streak-from-label'), ', from ', 30, null, alive, snap);
            if (!alive()) { slide3Animating = false; return; }
            scrollReveal(document.getElementById('s3-streak-from'), dateCountUpOptions(fmtStreakDate(d.streakStart)), fmtStreakDate(d.streakStart), 800, null, alive, snap);
            await delay(900, alive, snap);
            if (!alive()) { slide3Animating = false; return; }
            await typewriter(document.getElementById('s3-streak-to-label'), ' to ', 40, null, alive, snap);
            if (!alive()) { slide3Animating = false; return; }
            scrollReveal(document.getElementById('s3-streak-to'), dateCountUpOptions(fmtStreakDate(d.streakEnd)), fmtStreakDate(d.streakEnd), 800, null, alive, snap);
            await delay(900, alive, snap);
            if (!alive()) { slide3Animating = false; return; }
        }
        await typewriter(document.getElementById('s3-streak-post'), '.', 30, null, alive, snap);
    }

    slide3Animating = false;
}

// ── Slide 4 ───────────────────────────────────────────────────────────────────

function formatHour(h) {
    if (h === 0) return '12 AM';
    if (h < 12) return `${h} AM`;
    if (h === 12) return '12 PM';
    return `${h - 12} PM`;
}

function hourScrollOptions(targetHour, n = 12) {
    const options = [];
    for (let i = n; i >= 1; i--) {
        options.push(formatHour((targetHour - i + 24) % 24));
    }
    return options;
}

function buildHourChart(barsEl, hourlyCounts, peakHour) {
    barsEl.innerHTML = '';
    const maxCount = Math.max(...hourlyCounts, 1);
    for (let h = 0; h < 24; h++) {
        const bar = document.createElement('div');
        const pct = (hourlyCounts[h] / maxCount * 100).toFixed(2);
        const level = hourlyCounts[h] === 0 ? 0 : Math.max(1, Math.ceil(hourlyCounts[h] / maxCount * 4));
        bar.className = `s4-bar s4-bar-l${level}` + (h === peakHour ? ' s4-bar-peak' : '');
        bar.dataset.targetPct = pct;
        bar.dataset.hour = h;
        bar.dataset.count = hourlyCounts[h];
        bar.style.height = '0%';
        bar.title = `${formatHour(h)}: ${hourlyCounts[h]}`;
        barsEl.appendChild(bar);
    }
}

function animateBars(barsEl, alive, snapFn) {
    const bars = [...barsEl.querySelectorAll('.s4-bar')];
    if (!bars.length) return Promise.resolve();
    const targets = bars.map(b => parseFloat(b.dataset.targetPct || '0'));
    const DURATION = 900;
    if (snapFn()) { bars.forEach((b, i) => { b.style.height = `${targets[i]}%`; }); return Promise.resolve(); }
    return new Promise(resolve => {
        const startTime = Date.now();
        const step = () => {
            if (!alive()) { resolve(); return; }
            if (snapFn()) { bars.forEach((b, i) => { b.style.height = `${targets[i]}%`; }); resolve(); return; }
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / DURATION, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            bars.forEach((b, i) => { b.style.height = `${targets[i] * eased}%`; });
            if (progress < 1) requestAnimationFrame(step);
            else { bars.forEach((b, i) => { b.style.height = `${targets[i]}%`; }); resolve(); }
        };
        requestAnimationFrame(step);
    });
}

function reset_slide4() {
    slide4Gen++;
    ['s4-intro', 's4-peak-hour', 's4-late-intro', 's4-late-count',
     's4-late-mid', 's4-late-pct', 's4-late-outro',
     's4-avg-pre', 's4-avg-val', 's4-avg-post'].forEach(id => {
        document.getElementById(id).textContent = '';
    });
    const chartWrap = document.getElementById('s4-chart-wrap');
    chartWrap.style.animation = 'none';
    chartWrap.style.opacity = '0';
    chartWrap.style.transform = 'translateY(6vh)';
    const barsEl = document.getElementById('s4-bars');
    if (barsEl) barsEl.innerHTML = '';
    const chartInfo = document.getElementById('s4-chart-info');
    chartInfo.style.transition = '';
    chartInfo.style.opacity = '0';
    chartInfo.querySelector('p').textContent = 'Tap/drag bars to view more info about an hour';
    const avgWrap = document.getElementById('s4-avg-wrap');
    avgWrap.style.transition = '';
    avgWrap.style.opacity = '0';
}

async function animate_slide4() {
    slide4Animating = true;
    slide4Snap = false;
    const myGen = slide4Gen;
    if (!RECAP_DATA) await dataReady;
    if (slide4Gen !== myGen) { slide4Animating = false; return; }
    const d = RECAP_DATA;
    const snap = () => slide4Snap;
    const alive = () => slide4Gen === myGen;

    if (!alive()) { slide4Animating = false; return; }
    const introText = d.mode === 'teacher' ? 'You grade most at ' : 'You\'re most active at ';
    await typewriter(document.getElementById('s4-intro'), introText, 35, null, alive, snap);

    if (!alive()) { slide4Animating = false; return; }
    scrollReveal(document.getElementById('s4-peak-hour'), hourScrollOptions(d.peak_hour), formatHour(d.peak_hour), 900, null, alive, snap);
    await delay(1100, alive, snap);

    if (!alive()) { slide4Animating = false; return; }
    const lateIntro = d.mode === 'teacher' ? 'You returned ' : 'You submitted ';
    await typewriter(document.getElementById('s4-late-intro'), lateIntro, 35, null, alive, snap);

    if (!alive()) { slide4Animating = false; return; }
    countUp(document.getElementById('s4-late-count'), 0, d.late_count, 800, null, alive, snap);
    await delay(250, alive, snap);

    if (!alive()) { slide4Animating = false; return; }
    const lateMid = d.mode === 'teacher' ? ' grades past 10 PM, which is ' : ' assignments past 10 PM, which is ';
    await typewriter(document.getElementById('s4-late-mid'), lateMid, 30, null, alive, snap);

    if (!alive()) { slide4Animating = false; return; }
    const pctEl = document.getElementById('s4-late-pct');
    const pctPromise = countUp(pctEl, 0, d.late_pct, 600, null, alive, snap, '%');
    await delay(100, alive, snap);

    if (!alive()) { slide4Animating = false; return; }
    const lateOutro = d.mode === 'teacher' ? ' of your grades.' : ' of your assignments.';
    await typewriter(document.getElementById('s4-late-outro'), lateOutro, 30, null, alive, snap);

    await pctPromise;
    if (!alive()) { slide4Animating = false; return; }

    if (!alive()) { slide4Animating = false; return; }
    await delay(300, alive, snap);

    const barsEl = document.getElementById('s4-bars');
    buildHourChart(barsEl, d.hourlyCounts, d.peak_hour);
    attachBarInteraction(barsEl, d.mode);

    const chartWrap = document.getElementById('s4-chart-wrap');
    chartWrap.style.opacity = '';
    chartWrap.style.transform = '';
    void chartWrap.offsetHeight;
    chartWrap.style.animation = 'graph-rise 0.6s ease both';
    await delay(400, alive, snap);
    if (snap()) {
        chartWrap.style.animation = 'none';
        chartWrap.style.opacity = '1';
        chartWrap.style.transform = 'translateY(0)';
    }

    if (!alive()) { slide4Animating = false; return; }
    await animateBars(barsEl, alive, snap);

    if (!alive()) { slide4Animating = false; return; }

    const chartInfo = document.getElementById('s4-chart-info');
    if (snap()) {
        chartInfo.style.transition = 'none';
        chartInfo.style.opacity = '1';
    } else {
        chartInfo.style.opacity = '1';
    }

    await delay(300, alive, snap);
    if (!alive()) { slide4Animating = false; return; }

    // Avg time before due stat (students only)
    const avgWrap = document.getElementById('s4-avg-wrap');
    const avgPre = document.getElementById('s4-avg-pre');
    const avgVal = document.getElementById('s4-avg-val');
    const avgPost = document.getElementById('s4-avg-post');
    if (d.mode === 'student' && d.avg_sec_before_due !== null) {
        const sec = d.avg_sec_before_due;
        const early = sec >= 0;
        const absSec = Math.abs(sec);
        let valText, postText;
        if (absSec < 3600) {
            valText = 'less than an hour';
            postText = early ? ' before the deadline on average.' : ' past the deadline on average.';
        } else if (absSec < 86400) {
            const hrs = Math.round(absSec / 3600);
            valText = `${hrs} hour${hrs !== 1 ? 's' : ''}`;
            postText = early ? ' before the deadline on average.' : ' past the deadline on average.';
        } else {
            const days = Math.round(absSec / 86400);
            valText = `${days} day${days !== 1 ? 's' : ''}`;
            postText = early ? ' before the deadline on average.' : ' past the deadline on average.';
        }
        const preText = early ? 'You submitted ' : 'You submitted ';
        if (snap()) {
            avgPre.textContent = preText;
            avgVal.textContent = valText;
            avgPost.textContent = postText;
            avgWrap.style.transition = 'none';
            avgWrap.style.opacity = '1';
        } else {
            avgWrap.style.opacity = '1';
            await typewriter(avgPre, preText, 30, null, alive, snap);
            if (!alive()) { slide4Animating = false; return; }
            await typewriter(avgVal, valText, 35, null, alive, snap);
            if (!alive()) { slide4Animating = false; return; }
            await typewriter(avgPost, postText, 30, null, alive, snap);
        }
    }

    slide4Animating = false;
}

// ─────────────────────────────────────────────────────────────────────────────

if (RECAP_ID) {
    initRecapData();
}

const hash_index = slide_ids.indexOf(location.hash.slice(1));
const start_index = hash_index >= 0 ? hash_index : 0;
slide_ids.forEach((id, i) => {
    document.getElementById(id).style.display = i === start_index ? "" : "none";
});
cur_slide = start_index;
if (slide_on_enter[slide_ids[cur_slide]]) slide_on_enter[slide_ids[cur_slide]]();
_updateDownloadBtn();

(async function initPhotoScroll() {
    const containers = [...document.querySelectorAll('.photos-album-selection-scroll')];
    if (!containers.length) return;

    let photos;
    const selRes = await fetch(`/photos/selection/${GALLERY_NAME}.json`);
    if (selRes.ok) {
        ({ photos } = await selRes.json());
    } else {
        const idxRes = await fetch('/photos/selection/_index.json').catch(() => null);
        if (idxRes && idxRes.ok) {
            ({ photos } = await idxRes.json());
        } else {
            const allRes = await fetch('https://photos.recap.pinewood.one/index/photos.json');
            const all = await allRes.json();
            for (let i = all.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [all[i], all[j]] = [all[j], all[i]];
            }
            photos = all.slice(0, 50).map(p => ({ path: p.path, type: 'random' }));
        }
    }

    for (let i = photos.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [photos[i], photos[j]] = [photos[j], photos[i]];
    }

    function _setupPhotoContainer(container) {
        function shouldUseThreeCols() {
            return document.documentElement.classList.contains('iosapp') &&
                   window.innerWidth > window.innerHeight;
        }

        function buildTrack(photoGroup, widthPct, leftPct) {
            const track = document.createElement('div');
            track.className = 'scroll-track';
            track.style.width = `${widthPct}%`;
            track.style.left = `${leftPct}%`;
            container.appendChild(track);
            [...photoGroup, ...photoGroup].forEach(photo => {
                const wrap = document.createElement('div');
                wrap.className = 'photo-wrap';
                const img = document.createElement('img');
                img.src = `https://photos.recap.pinewood.one/${photo.path}`;
                img.loading = 'lazy';
                img.decoding = 'async';
                wrap.appendChild(img);
                track.appendChild(wrap);
            });
            return track;
        }

        function applyCrinkle() {
            container.style.setProperty('--crinkle-rot', `${Math.random() * 360}deg`);
            container.style.setProperty('--crinkle-x', `${Math.random() * 100}%`);
            container.style.setProperty('--crinkle-y', `${Math.random() * 100}%`);
        }

        let intervalId = null;
        let activeMode = null;

        function startLayout() {
            if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
            container.querySelectorAll('.scroll-track').forEach(t => t.remove());

            const useThreeCols = shouldUseThreeCols();
            activeMode = useThreeCols ? 'three' : 'single';

            const tracks = [];

            if (useThreeCols) {
                const n = photos.length;
                const t = Math.ceil(n / 3);
                const groups = [photos.slice(0, t), photos.slice(t, t * 2), photos.slice(t * 2)];
                groups.forEach(g => {
                    for (let i = g.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [g[i], g[j]] = [g[j], g[i]];
                    }
                });
                const colW = 32, centers = [10, 50, 90];
                const stepFactors = [1.0, 0.65, 1.1];
                groups.forEach((g, i) => {
                    tracks.push({ track: buildTrack(g, colW, centers[i] - colW / 2), y: 0, stepFactor: stepFactors[i] });
                });
            } else {
                tracks.push({ track: buildTrack(photos, 67, 16.5), y: 0, stepFactor: 1.0 });
            }

            const step = container.offsetHeight * 0.2;
            let flip = 1;

            function applyRotations() {
                tracks.forEach(({ track }) => {
                    track.querySelectorAll('.photo-wrap').forEach((wrap, i) => {
                        const sign = (i % 2 === 0 ? 1 : -1) * flip;
                        wrap.style.transform = `rotate(${sign * (Math.random() * 10 + 5)}deg)`;
                    });
                });
            }

            applyCrinkle();
            applyRotations();

            intervalId = setInterval(() => {
                tracks.forEach(state => {
                    state.y += step * state.stepFactor;
                    const half = state.track.scrollHeight / 2;
                    if (half > 0 && state.y >= half) state.y = 0;
                    state.track.style.transform = `translateY(-${state.y}px)`;
                });
                flip *= -1;
                applyRotations();
                applyCrinkle();
            }, 800);
        }

        startLayout();

        window.addEventListener('resize', () => {
            const newMode = shouldUseThreeCols() ? 'three' : 'single';
            if (newMode !== activeMode) startLayout();
        });
    }

    containers.forEach(_setupPhotoContainer);
})();
