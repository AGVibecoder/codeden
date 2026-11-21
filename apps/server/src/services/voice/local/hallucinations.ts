/**
 * Sentences Whisper makes up when it hears (almost) nothing: it learned from video subtitles,
 * so silence comes out as a video's closing line or a subtitler's credit. Only a segment that
 * is nothing but one of these is dropped, so a real sentence that contains the words stays.
 */
const MADE_UP = [
  // English
  "this is the end of the video",
  "thank you for watching",
  "thanks for watching",
  "thank you for watching and see you next time",
  "thanks for watching see you next time",
  "please subscribe",
  "please subscribe to my channel",
  "don t forget to like and subscribe",
  "like and subscribe",
  "see you in the next video",
  "see you next time",
  "subtitles by the amara org community",
  "transcribed by",
  "you",
  // Dutch
  "bedankt voor het kijken",
  "bedankt voor het kijken en tot de volgende keer",
  "tot de volgende keer",
  "abonneer op het kanaal",
  "vergeet niet te abonneren",
  "ondertiteling door de amara org gemeenschap",
  "ondertitels ingediend door de amara org gemeenschap",
  "ondertiteld door de amara org gemeenschap",
  "tv gelderland 2021",
  // German and French, often guessed for other languages
  "untertitel im auftrag des zdf",
  "untertitel der amara org community",
  "vielen dank fürs zuschauen",
  "sous titres réalisés par la communauté d amara org",
  "merci d avoir regardé",
];

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const KNOWN = new Set(MADE_UP.map(normalize));

/** True when the whole transcript is one of Whisper's made-up silence sentences. */
export function isMadeUp(text: string): boolean {
  const said = normalize(text);
  return said.length > 0 && KNOWN.has(said);
}
