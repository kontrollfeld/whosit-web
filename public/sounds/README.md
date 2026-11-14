# whosit sound mark

`whosit-klangzeichen.mp3`: the Morse code **QRZ** ("who is calling me?", − − · −  · − ·  − − · ·),
eleven tones in 2.4 s, the same eleven as the pieces of the logo's ring (since 2026-11-13; there is
no voice any more, so `whosit-klangzeichen-ohne-stimme.mp3` is the same sound under its old name).
Played in `public/app.js`:
letter by letter along the steps of a call, with the logo's ring (Q, R and Z, 32 dB under the
file, 26 dB under the mark's usual playback level), and the Q when the "Töne" switch is turned on — only on instances without operator
branding (an operator name); branded instances keep the neutral chime.
`whosit-klangzeichen-hauch.mp3` is the full mark 32 dB quieter, for the app's start: the same level
as the ring in a call (since 2026-11-14; before, a copy 12 dB quieter). iOS ignores the volume of
media elements, so the level is in the file.

Like the logo, these are brand assets: copied unchanged from the media kit
(`media-kit/klang/`, where the source scripts and the WAV originals live). The licence covers the
files; it grants no right to the sound mark as a trademark. A new version comes from the media
kit, not by editing these files.
