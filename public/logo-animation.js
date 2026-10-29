// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/* The whosit logo animation — the ONE approved animation of the logo (brand owner, 2026-10-29,
   variant "Morse über osi"). It runs in step with the sound mark (public/sounds/):

     0.0 s   speech bubble pops in, the ring builds up faintly clockwise
     0.4 s   the word "whosit" slides in while the voice asks "whosit?"
     0.9 s   first long tone (M): a gold dash appears above the "o", 5 ring arcs light up
     1.3 s   second long tone: a dash above the "s", 4 more arcs
     1.9 s   short tone (E): the STAR above the "i" pops in — the star is the dot; last 2 arcs,
             the tick pulses
     1.95 s  "EUDI VERIFIED CALL"; from 2.4 s the dashes fade, and what is left is the logo

   Built at runtime from the unchanged file public/logo/logo-horizontal-colour.svg: every path
   keeps its coordinates and colour. Only the ring (one path of 11 arcs) gets a copy split into its
   11 arcs on top while it plays, so the arcs can light up one by one; the two dashes exist only
   while it plays. When the animation has run, remove the trigger class (`la-play`) — then the
   picture IS the file again, down to the pixel (held animations are rasterised on layers of their
   own, slightly differently).

   Usage:
     const svg = await whositLogoAnimation.load('logo/logo-horizontal-colour.svg');
     box.appendChild(svg); box.classList.add('la-play');     // CSS: logo-animation.css

   The media kit renders its films and the standalone animation from this file too — change the
   choreography here, not there. Never anything but the colour file on light ground (see
   public/logo/README.md). */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';

  function el(name, attrs) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function build(svgText) {
    var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    var svg = doc.documentElement;
    var paths = svg.querySelectorAll('path');
    if (paths.length !== 26) throw new Error('logo file changed: expected 26 paths, got ' + paths.length);
    var ring = paths[0], bubble = paths[1], tick = paths[2], star = paths[9];
    svg.classList.add('la');
    svg.setAttribute('aria-hidden', 'true');

    ring.classList.add('la-ring-file');
    var arcs = el('g', { 'class': 'la-arcs' });
    (ring.getAttribute('d').match(/M[^M]+/g) || []).forEach(function (d, k) {
      var a = ring.cloneNode(false);
      a.setAttribute('d', d.trim());
      a.setAttribute('class', 'la-arc');
      a.style.setProperty('--k', k);
      arcs.appendChild(a);
    });
    ring.parentNode.insertBefore(arcs, ring.nextSibling);

    bubble.classList.add('la-bubble');
    tick.classList.add('la-tick');
    for (var i = 3; i <= 8; i++) { paths[i].classList.add('la-letter'); paths[i].style.setProperty('--k', i - 3); }
    star.classList.add('la-star');
    var sub = el('g', { 'class': 'la-sub' });
    svg.insertBefore(sub, paths[10]);
    for (var j = 10; j < 26; j++) sub.appendChild(paths[j]);

    // M = − − above "o" and "s", on the star's line (star centre 450 / −65.5; o 338–388, s 392–434).
    var row = el('g', { 'class': 'la-mrow' });
    row.appendChild(el('rect', { 'class': 'la-dash la-d1', x: 347.9, y: -69, width: 30, height: 7, rx: 3.5, fill: '#FFCC00' }));
    row.appendChild(el('rect', { 'class': 'la-dash la-d2', x: 398, y: -69, width: 30, height: 7, rx: 3.5, fill: '#FFCC00' }));
    svg.appendChild(row);
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
