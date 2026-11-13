# whosit logo

`logo-horizontal-colour.svg` (light ground) and `logo-horizontal-white.svg` (dark ground) are
copied **unchanged** from the whosit logo kit. The approved design: the large "whosit" wordmark
with the gold star as the dot on the i, spanning the full width of the claim "EUDI VERIFIED
CONTACT". The dashed ring around the speech bubble is the Morse code QRZ ("who is calling me?",
− − · −  · − ·  − − · ·), its word gap at the bubble's tail (since 2026-11-13).

- Do not edit these files, and do not rebuild the logo from the mark plus HTML text. A changed
  logo comes as new files from the kit, and only when the brand owner asks for it.
- The licence of this repository covers the files as files. It grants no right to the name or the
  logo as a trademark; see the brand sheet in the logo kit.

## The logo animation

There is exactly **one** approved animation of the logo (brand owner, 2026-11-13: "QRZ"):
`public/logo-animation.js` + `public/logo-animation.css`. In step with the sound mark, whose eleven
tones are QRZ, the eleven pieces of the ring appear one by one, each with its tone; then the star
above the "i" flashes and the tick pulses. It is built at runtime from `logo-horizontal-colour.svg`
without changing a path, and its resting picture is the file itself.

- Animate the logo only with this, everywhere: in the call (once when it connects), in the media
  kit's films and the standalone animation. No other choreography, no variants.
- Only on light ground (it uses the colour file), and never on operator-branded instances.
- Without text around it: no "Who is it? / Wer ist dran?" above it.
