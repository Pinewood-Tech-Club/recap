slide_ids = ["slide1", "slide2"]

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

function make_title_animate() {
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
    setTimeout(() => {
        const bounce = () => {
            span.style.animation = "none";
            span.offsetHeight; // force reflow
            span.style.animation = "title-text-fade-in 0.6s cubic-bezier(0.36, 0.07, 0.19, 0.97) forwards";
        };
        bounce();
    }, i * OFFSET);
});setTimeout(() => {make_things_bounce();}, OFFSET*chars.length)}

make_title_animate();

(async function initPhotoScroll() {
    const container = document.querySelector('.photos-album-selection-scroll');
    if (!container) return;

    const res = await fetch('https://photos.recap.pinewood.one/selection/sean_sirhan.json');
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

    const imgs = track.querySelectorAll('.photo-wrap');
    const step = container.offsetHeight * 0.2;
    let y = 0;
    let flip = 1;

    const bg = container;
    function applyCrinkle() {
        bg.style.setProperty('--crinkle-rot', `${Math.random() * 360}deg`);
        bg.style.setProperty('--crinkle-x', `${Math.random() * 100}%`);
        bg.style.setProperty('--crinkle-y', `${Math.random() * 100}%`);
    }

    function applyRotations() {
        imgs.forEach((img, i) => {
            const sign = (i % 2 === 0 ? 1 : -1) * flip;
            const deg = Math.random() * (15 - 5) + 5;
            img.style.transform = `rotate(${sign * deg}deg)`;
        });
    }

    applyCrinkle();
    applyRotations();

    setInterval(() => {
        y += step;
        if (y >= track.scrollHeight / 2) y = 0;
        track.style.transform = `translateY(-${y}px)`;
        flip *= -1;
        applyRotations();
        applyCrinkle();
    }, 800);
})();