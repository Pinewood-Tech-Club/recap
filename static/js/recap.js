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

const slide_on_enter = {
    slide1: () => { reset_slide1(); make_title_animate(); },
    slide2: () => { reset_slide2(); animate_slide2(); },
    slide3: () => { reset_slide3(); animate_slide3(); },
};

const slide_on_exit = {
    slide1: () => { slide1Snap = false; slide1Animating = false; _slide1Timeouts.forEach(t => clearTimeout(t)); _slide1Timeouts = []; },
    slide2: () => { slide2Gen++; slide2Snap = false; slide2Animating = false; },
    slide3: () => { slide3Gen++; slide3Snap = false; slide3Animating = false; },
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
}

function next_slide() { go_to_slide(cur_slide + 1); }
function prev_slide() { go_to_slide(cur_slide - 1); }
function isAnimating() {
    const id = slide_ids[cur_slide];
    if (id === 'slide1') return slide1Animating;
    if (id === 'slide2') return slide2Animating;
    if (id === 'slide3') return slide3Animating;
    return false;
}
function snapCurrent() {
    const id = slide_ids[cur_slide];
    if (id === 'slide1') snap_slide1();
    if (id === 'slide2') slide2Snap = true;
    if (id === 'slide3') slide3Snap = true;
}
function forward()  { if (isAnimating()) { snapCurrent(); } else { next_slide(); } }
function backward() { if (isAnimating()) { snapCurrent(); } else { prev_slide(); } }

document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") forward();
    if (e.key === "ArrowLeft"  || e.key === "ArrowUp")   backward();
});

document.querySelector(".slides").addEventListener("click", forward);

let _touch_start_x = null;
let _suppressSwipe = false;
document.addEventListener("touchstart", (e) => { _touch_start_x = e.touches[0].clientX; _suppressSwipe = false; }, { passive: true, capture: true });
document.addEventListener("touchend", (e) => {
    if (_touch_start_x === null || _suppressSwipe) { _touch_start_x = null; _suppressSwipe = false; return; }
    const dx = e.changedTouches[0].clientX - _touch_start_x;
    if (Math.abs(dx) > 40) dx < 0 ? forward() : backward();
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
        if (v <= p33) return 1;
        if (v <= p60) return 2;
        if (v <= p90) return 3;
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

function computeRecapStats(raw) {
    const dailyCounts = {};
    const monthCounts = {};
    let total = 0;
    for (const course of raw.assignments || []) {
        for (const ev of course.data || []) {
            const t = ev.t;
            total += 1;
            const dateKey = epochToPSTDate(t); // YYYY-MM-DD
            dailyCounts[dateKey] = (dailyCounts[dateKey] || 0) + 1;
            const monthIdx = parseInt(dateKey.slice(5, 7), 10) - 1;
            const monthName = _MONTH_NAMES[monthIdx];
            monthCounts[monthName] = (monthCounts[monthName] || 0) + 1;
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

    const top_courses = raw.mode === 'student'
        ? Object.entries(
            (raw.assignments || []).reduce((acc, c) => {
                acc[c.course] = (acc[c.course] || 0) + (c.data || []).length;
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
    };
}

async function initRecapData() {
    const resp = await fetch(`/api/recap/${RECAP_ID}`);
    const json = await resp.json();
    RECAP_DATA = computeRecapStats(json.slides);
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

function countUp(el, from, to, durationMs, ncEl, alive, snapFn = () => false) {
    if (snapFn()) { el.textContent = to; if (ncEl) updateNotecard(ncEl); return Promise.resolve(); }
    return new Promise(resolve => {
        const startTime = Date.now();
        const step = () => {
            if (alive && !alive()) { resolve(); return; }
            if (snapFn()) { el.textContent = to; if (ncEl) updateNotecard(ncEl); resolve(); return; }
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / durationMs, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            el.textContent = Math.round(from + (to - from) * eased);
            if (ncEl) updateNotecard(ncEl);
            if (progress < 1) {
                requestAnimationFrame(step);
            } else {
                el.textContent = to;
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
    ['s2-m-intro','s2-month-name','s2-m-mid','s2-month-count','s2-m-outro',
     's2-d-intro','s2-day-name','s2-d-mid','s2-day-count','s2-d-outro'].forEach(id => {
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
    if (snap()) {
        graph.style.animation = 'none'; graph.style.opacity = '1'; graph.style.transform = 'translateY(0)';
        graphInfo.style.transition = 'none';
        graphInfo.style.opacity = '1';
    }

    if (!alive()) { slide3Animating = false; return; }
    graphInfo.style.opacity = '1';

    slide3Animating = false;
}

// ─────────────────────────────────────────────────────────────────────────────

if (IS_GENERATING) {
    let _dataFetched = false;
    const _fetchOnce = () => { if (!_dataFetched) { _dataFetched = true; initRecapData(); } };
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/job/${RECAP_ID}`);
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.status === 'done') { ws.close(); _fetchOnce(); }
    };
    ws.onerror = () => _fetchOnce();
    ws.onclose = () => _fetchOnce();
} else {
    initRecapData();
}

const hash_index = slide_ids.indexOf(location.hash.slice(1));
const start_index = hash_index >= 0 ? hash_index : 0;
slide_ids.forEach((id, i) => {
    document.getElementById(id).style.display = i === start_index ? "" : "none";
});
cur_slide = start_index;
if (slide_on_enter[slide_ids[cur_slide]]) slide_on_enter[slide_ids[cur_slide]]();

(async function initPhotoScroll() {
    const container = document.querySelector('.photos-album-selection-scroll');
    if (!container) return;

    const res = await fetch('https://photos.recap.pinewood.one/selection/mailey_wang.json');
    const { photos } = await res.json();

    for (let i = photos.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [photos[i], photos[j]] = [photos[j], photos[i]];
    }

    const track = document.createElement('div');
    track.className = 'scroll-track';
    container.appendChild(track);

    // Render photos twice for seamless looping
    [...photos, ...photos].forEach(photo => {
        const wrap = document.createElement('div');
        wrap.className = 'photo-wrap';
        const img = document.createElement('img');
        img.src = `https://photos.recap.pinewood.one/${photo.path}`;
        img.loading = 'lazy';
        img.decoding = 'async';
        wrap.appendChild(img);
        track.appendChild(wrap);
    });

    // Assign each photo a fixed random tilt once — no alternating per tick
    track.querySelectorAll('.photo-wrap').forEach((wrap, i) => {
        const sign = i % 2 === 0 ? 1 : -1;
        const deg = Math.random() * 10 + 5;
        wrap.style.transform = `rotate(${sign * deg}deg)`;
    });

    container.style.setProperty('--crinkle-rot', `${Math.random() * 360}deg`);
    container.style.setProperty('--crinkle-x', `${Math.random() * 100}%`);
    container.style.setProperty('--crinkle-y', `${Math.random() * 100}%`);

    const PX_PER_SEC = 150;
    const CRINKLE_INTERVAL = 800;
    let y = 0;
    let lastTime = null;
    let lastCrinkle = 0;

    function applyCrinkle() {
        container.style.setProperty('--crinkle-rot', `${Math.random() * 360}deg`);
        container.style.setProperty('--crinkle-x', `${Math.random() * 100}%`);
        container.style.setProperty('--crinkle-y', `${Math.random() * 100}%`);
    }

    function scrollStep(ts) {
        if (lastTime !== null) {
            const dt = (ts - lastTime) / 1000;
            y += PX_PER_SEC * dt;
            const half = track.scrollHeight / 2;
            if (y >= half) y -= half;
            track.style.transform = `translateY(-${y}px)`;
        }
        if (ts - lastCrinkle > CRINKLE_INTERVAL) {
            applyCrinkle();
            lastCrinkle = ts;
        }
        lastTime = ts;
        requestAnimationFrame(scrollStep);
    }
    requestAnimationFrame(scrollStep);
})();
