// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Apply an instance's branding in the browser — name, logo, favicon.
 *
 * This script does NOT handle the colour: that arrives as `<style id="brand-accent">` immediately
 * before `</head>`, and therefore after the stylesheets (see src/branding.ts). What remains here
 * is what cannot be solved with CSS.
 *
 * Without `window.EUDI_BRANDING` nothing happens. The script is only injected when an instance is
 * branded — so it is not even in the way on an unbranded deployment.
 */
(function () {
  var b = window.EUDI_BRANDING;
  if (!b || (!b.name && !b.logo)) return;

  if (b.name) {
    // The header brand only. The product name inside running text stays as it is: it sits within
    // translated sentences, and swapping it by search-and-replace would produce crooked grammar in
    // three languages.
    var namen = document.querySelectorAll('[data-brand-name]');
    for (var i = 0; i < namen.length; i++) namen[i].textContent = b.name;
    // Carry along labels that contain the name — otherwise a screen reader keeps announcing the
    // old brand.
    var lockups = document.querySelectorAll('[data-brand-lockup], [aria-label*="EUDI Verified Call"]');
    for (var j = 0; j < lockups.length; j++) {
      var al = lockups[j].getAttribute('aria-label');
      if (al) lockups[j].setAttribute('aria-label', al.replace(/EUDI Verified Call/g, b.name));
    }
  }

  if (b.name) {
    /**
     * The product name where it is READ, not where it identifies the software.
     *
     * Two places only, each marked or addressed by id — deliberately not a search-and-replace
     * over the document. The name sits inside translated sentences, and swapping it everywhere
     * produces crooked grammar in three languages; that judgement has not changed. What HAS
     * changed is that these two are not sentences at all:
     *
     *   [data-brand-product]  the "about" line in the settings, where the name stands alone
     *   #cal-title            the appointment title, which ends up in a GUEST'S calendar and in
     *                         the .ics file they receive. Under the operator's brand it reads as
     *                         an appointment with them; under ours it names a company the guest
     *                         has never heard of and did not arrange anything with.
     *
     * NOT branded, on purpose: `PRODID` in the .ics. That field identifies the software that
     * produced the file, which is this software, whoever runs it.
     *
     * Runs twice — now, and again once translations have been applied. `applyI18n` writes
     * textContent from its own dictionary and would otherwise put the original name back; it
     * keeps the German source in `dataset.i18nKey`, so this pass cannot corrupt the lookup.
     */
    var brandProduct = function () {
      var texts = document.querySelectorAll('[data-brand-product]');
      for (var m = 0; m < texts.length; m++) {
        texts[m].textContent = texts[m].textContent.replace(/EUDI Verified Call/g, b.name);
      }
      var cal = document.getElementById('cal-title');
      // Only while untouched: overwriting what someone typed would be worse than the wrong default.
      if (cal && cal.value === 'EUDI Verified Call') cal.value = b.name;
    };
    brandProduct();
    if (typeof i18nReady !== 'undefined' && i18nReady && i18nReady.then) i18nReady.then(brandProduct);
  }

  if (b.logo) {
    // The bundled logo is an inline SVG; a customer logo is a file. What gets replaced is
    // therefore the element, not its content — and the measured size is carried over, otherwise
    // the header jumps when it is swapped.
    var marks = document.querySelectorAll('[data-brand-logo], [data-brand-lockup] > svg');
    for (var k = 0; k < marks.length; k++) {
      var alt = marks[k];
      var box = alt.getBoundingClientRect();
      var img = document.createElement('img');
      img.src = b.logo;
      img.alt = b.name || '';
      if (box.width) img.style.width = box.width + 'px';
      if (box.height) img.style.height = box.height + 'px';
      img.className = alt.getAttribute('class') || '';
      alt.parentNode.replaceChild(img, alt);
    }
    var icon = document.querySelector('link[rel="icon"]') || document.createElement('link');
    icon.rel = 'icon';
    icon.href = b.logo;
    if (!icon.parentNode) document.head.appendChild(icon);
  }
})();
