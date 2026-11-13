// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/* The whosit logo animation — the ONE approved animation of the logo (brand owner, 2026-11-13,
   "QRZ": the ring is the Morse code QRZ, "who is calling me?"). It runs in step with the sound
   mark (public/sounds/), whose eleven tones are the eleven pieces of the ring:

     0.0 s   the logo stands, without its ring
     0.02 s  Q  − − · −   each ring piece appears, clockwise from the bubble's tail, the moment
     0.98 s  R  · − ·     its tone starts
     1.58 s  Z  − − · ·   (last tone ends at 2.24 s)
     2.36 s  the star above the "i" flashes, the tick pulses; what is left is the logo

   Built at runtime from the unchanged file public/logo/logo-horizontal-colour.svg: every path
   keeps its coordinates and colour. Only the ring (one path of 11 pieces) gets a copy split into its
   11 pieces on top while it plays, so they can appear one by one. When the animation has run,
   remove the trigger class (`la-play`) — then the picture IS the file again, down to the pixel
   (held animations are rasterised on layers of their own, slightly differently).

   Usage:
     const svg = await whositLogoAnimation.load('logo/logo-horizontal-colour.svg');
     box.appendChild(svg); box.classList.add('la-play');     // CSS: logo-animation.css

   The media kit renders its films and the standalone animation from this file too — change the
   choreography here, not there. Never anything but the colour file on light ground (see
   public/logo/README.md). */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  // When each tone of the sound mark starts (seconds; measured in whosit-klangzeichen.mp3): Q R Z.
  var TONES = [0.016, 0.256, 0.496, 0.616, 0.976, 1.096, 1.336, 1.576, 1.816, 2.056, 2.176];

  function el(name, attrs) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function build(svgText) {
    var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    var svg = doc.documentElement;
    var paths = svg.querySelectorAll('path');
    if (paths.length !== 29) throw new Error('logo file changed: expected 29 paths, got ' + paths.length);
    var ring = paths[0], tick = paths[2], star = paths[9];
    svg.classList.add('la');
    svg.setAttribute('aria-hidden', 'true');

    ring.classList.add('la-ring-file');
    var pieces = ring.getAttribute('d').match(/M[^M]+/g) || [];
    if (pieces.length !== TONES.length) throw new Error('logo file changed: expected ' + TONES.length + ' ring pieces');
    var arcs = el('g', { 'class': 'la-arcs' });
    pieces.forEach(function (d, k) {
      var a = ring.cloneNode(false);
      a.setAttribute('d', d.trim());
      a.setAttribute('class', 'la-arc');
      a.style.setProperty('--la-on', TONES[k] + 's');
      arcs.appendChild(a);
    });
    ring.parentNode.insertBefore(arcs, ring.nextSibling);

    tick.classList.add('la-tick');
    star.classList.add('la-star');
    return document.importNode(svg, true);
  }

  /** Runs it once in `box` (which holds the built svg): adds `la-play`, and removes it again when
   *  every animation has finished, so the resting picture is exactly the file.
   *  `opts.clock`: a function returning how many seconds of the sound mark are audible right now
   *  (negative: not yet). The picture then follows the SOUND, not the other way round — a media
   *  element or the audio output starts a little late, and on a phone that is easily heard. It is
   *  set when the animation starts and once more shortly after (a media clock moves in steps). */
  function play(box, opts) {
    var clock = opts && opts.clock;
    box.classList.remove('la-play');
    void box.getBoundingClientRect(); // restart
    box.classList.add('la-play');
    var run = (box.__laRun = (box.__laRun || 0) + 1);
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        var anims = box.getAnimations ? box.getAnimations({ subtree: true }) : [];
        var sync = function () {
          if (!clock || box.__laRun !== run) return;
          var t = clock();
          if (typeof t !== 'number' || !isFinite(t)) return;
          anims.forEach(function (a) { try { a.currentTime = t * 1000; } catch (e) { /* finished */ } });
        };
        sync();
        if (clock) setTimeout(sync, 300);
        Promise.all(anims.map(function (a) { return a.finished; }))
          .then(function () { if (box.__laRun === run) box.classList.remove('la-play'); resolve(); })
          .catch(resolve);
      });
    });
  }

  window.whositLogoAnimation = {
    build: build,
    play: play,
    load: function (url) { return fetch(url).then(function (r) { return r.text(); }).then(build); },
  };
})();
