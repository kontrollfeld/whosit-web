// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A privacy notice built from what this instance actually does, plus the few things only its
 * operator can say.
 *
 * WHY. Art. 13 GDPR asks for facts, and most of them are facts about the software and its
 * configuration: which attributes the wallet is asked for, whose STUN server sees the visitor's IP
 * address, whether a relay is the operator's own, which module keeps what. An operator writing the
 * page by hand gets exactly those wrong — and gets them wrong again after the next configuration
 * change, because nobody rereads a privacy notice when switching a TURN server. So the core says
 * what it knows about itself, every time the page is requested, and the operator adds what it
 * cannot know: who they are, what they use the instance for and on which legal basis, who hosts it
 * and what the server logs.
 *
 *   datenschutz.html   wins — an operator's own page is never second-guessed (./operator-pages)
 *   datenschutz.json   the operator's details; with them this module renders the page
 *   neither            the placeholder in public/, saying no notice was provided
 *
 * The controller is taken from impressum.json (the same people, written once); `verantwortlich`
 * in datenschutz.json is for an operator whose imprint is an HTML page of their own.
 *
 * Modules speak for themselves: a module that processes personal data declares a `privacy`
 * paragraph in its manifest (see ./core/modules). One that declares nothing is NAMED as such on the
 * page — silence would read as "processes nothing", and that is not something the core can know.
 *
 * Text only, escaped here; nothing in either file can add markup.
 */
import fs from 'fs';
import path from 'path';
import type { Imprint, OperatorPagesConfig } from './operator-pages';

/** The legal bases an operator can choose (Art. 6(1) GDPR). */
export const RECHTSGRUNDLAGEN = {
  einwilligung: 'Art. 6 Abs. 1 lit. a DSGVO (Einwilligung)',
  vertrag: 'Art. 6 Abs. 1 lit. b DSGVO (Vertrag oder vorvertragliche Maßnahmen)',
  rechtspflicht: 'Art. 6 Abs. 1 lit. c DSGVO (rechtliche Verpflichtung)',
  'oeffentliche-aufgabe': 'Art. 6 Abs. 1 lit. e DSGVO (Aufgabe im öffentlichen Interesse oder in Ausübung öffentlicher Gewalt)',
  'berechtigtes-interesse': 'Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse)',
} as const;
export type Rechtsgrundlage = keyof typeof RECHTSGRUNDLAGEN;

/** datenschutz.json */
export interface PrivacyDetails {
  zweck: string;                     // what the instance is used for, one line
  rechtsgrundlage: Rechtsgrundlage;
  hosting: string;                   // who runs the servers, where; processors
  protokolle: string;                // what the server logs and for how long
  dsb?: string;                      // data protection officer, name and contact
  aufsicht?: string;                 // the competent supervisory authority
  verantwortlich?: string;           // controller, when there is no impressum.json
  stand?: string;                    // YYYY-MM-DD
}

const PFLICHT = ['zweck', 'rechtsgrundlage', 'hosting', 'protokolle'] as const;
const FREI = ['dsb', 'aufsicht', 'verantwortlich', 'stand'] as const;
// Longer than an imprint line: "hosting" and "protokolle" are a sentence or two.
const TEXT = /^[^\u0000-\u001f\u007f]{1,600}$/;

export function parsePrivacy(raw: unknown): { details: PrivacyDetails } | { fehler: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { fehler: 'kein JSON-Objekt' };
  const o = raw as Record<string, unknown>;
  const unbekannt = Object.keys(o).filter((k) => !(PFLICHT as readonly string[]).includes(k) && !(FREI as readonly string[]).includes(k));
  if (unbekannt.length) return { fehler: `unbekannte Felder: ${unbekannt.join(', ')}` };
  const out: Record<string, string> = {};
  for (const k of [...PFLICHT, ...FREI]) {
    const v = o[k];
    if (v === undefined || v === null || v === '') {
      if ((PFLICHT as readonly string[]).includes(k)) return { fehler: `${k} fehlt` };
      continue;
    }
    if (typeof v !== 'string' || !TEXT.test(v.trim())) return { fehler: `${k} ist kein einzeiliger Text (höchstens 600 Zeichen)` };
    out[k] = v.trim();
  }
  if (!(out.rechtsgrundlage in RECHTSGRUNDLAGEN)) {
    return { fehler: `rechtsgrundlage muss eine von ${Object.keys(RECHTSGRUNDLAGEN).join(', ')} sein` };
  }
  if (out.stand && !/^\d{4}-\d{2}-\d{2}$/.test(out.stand)) return { fehler: 'stand ist kein Datum (JJJJ-MM-TT)' };
  return { details: out as unknown as PrivacyDetails };
}

/** datenschutz.json from the operator's directory, read per request like everything there. */
export function readPrivacy(cfg: OperatorPagesConfig): { details: PrivacyDetails } | { fehler: string } | null {
  let text: string;
  try { text = fs.readFileSync(path.join(cfg.dir, 'datenschutz.json'), 'utf8'); } catch { return null; }
  try { return parsePrivacy(JSON.parse(text)); } catch { return { fehler: 'kein gültiges JSON' }; }
}

/** What the instance does, as far as the core can tell. Built by the caller from its config. */
export interface PrivacyFacts {
  /** PID attributes this instance may request (the WRP policy, narrowed). */
  attributes: readonly string[];
  /** STUN servers, as URLs. */
  stun: readonly string[];
  /** The relay: the operator's own (host), the public fallback, or none. */
  turn: { art: 'eigen'; host: string } | { art: 'oeffentlich' } | { art: 'keiner' };
  /** Host of the verifier (EUDIPLO), or null when none is configured. */
  verifier: string | null;
  /** Monthly call totals kept on disk (EUDI_USAGE_FILE). */
  usage: boolean;
  /** Signed appointment links. */
  invites: boolean;
  /** A list of who may host (EUDI_HOST_FILE / EUDI_HOST_ALLOWLIST). */
  hostList: boolean;
  /** Further credentials requested during a call (the instance's catalog). */
  inCallCredentials: boolean;
  /** The loaded modules, with their own paragraph where they declare one. */
  modules: ReadonlyArray<{ id: string; titles: string[]; privacy?: { title: string; text: string } }>;
}

const ATTR_LABEL: Record<string, string> = {
  given_name: 'Vorname',
  family_name: 'Familienname',
  age_over_18: 'die Angabe, ob Sie volljährig sind (ohne Geburtsdatum)',
  pseudonym_id: 'ein Pseudonym, das nur für diese Instanz gilt',
  birth_date: 'Geburtsdatum',
  issuing_country: 'ausstellender Staat',
  nationality: 'Staatsangehörigkeit',
  address: 'Anschrift',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const p = (s: string) => `<p>${s}</p>`;
const host = (url: string) => url.replace(/^(stun|turns?):/i, '').replace(/^\/\//, '').split(/[:?/]/)[0];
// Servers of companies outside the EU/EEA, where an IP address may leave it. Only the ones the
// core itself defaults to; anything else the operator configured is named, not judged.
const DRITTLAND = /(^|\.)(google\.com|cloudflare\.com|metered\.ca)$/i;

/** The placeholder page with the generated notice in place of its "no notice provided" block. */
export function renderPrivacy(placeholder: string, d: PrivacyDetails, imprint: Imprint | null, f: PrivacyFacts): string {
  const teile: string[] = [];

  // 1. Who is responsible
  teile.push('<h2>Verantwortlich</h2>');
  if (imprint) {
    teile.push(p(`<strong>${esc(imprint.name)}</strong><br />${esc(imprint.strasse)}<br />${esc(imprint.ort)}${imprint.land ? `<br />${esc(imprint.land)}` : ''}<br />E-Mail: <a href="mailto:${esc(imprint.email)}">${esc(imprint.email)}</a>${imprint.telefon ? `<br />Telefon: ${esc(imprint.telefon)}` : ''}`));
  } else {
    teile.push(p(esc(d.verantwortlich!)));
  }
  if (d.dsb) teile.push(p(`Datenschutzbeauftragte(r): ${esc(d.dsb)}`));
  teile.push(p('Verantwortlich ist, wer diesen Dienst betreibt — nicht, wer die Software geschrieben hat. Die folgenden Angaben zur Technik erzeugt die Software aus der tatsächlichen Konfiguration dieser Instanz; sie ändern sich mit ihr.'));

  // 2. Purpose and legal basis
  teile.push('<h2>Wofür wir Ihre Daten verarbeiten</h2>');
  teile.push(p(`${esc(d.zweck)}<br />Rechtsgrundlage: ${esc(RECHTSGRUNDLAGEN[d.rechtsgrundlage])}.`));

  // 3. Hosting and logs
  teile.push('<h2>Betrieb und Server-Protokolle</h2>');
  teile.push(p(`Betrieb: ${esc(d.hosting)}`));
  teile.push(p(`Protokolle: ${esc(d.protokolle)}`));

  // 4. The call
  teile.push('<h2>Das Gespräch</h2>');
  teile.push(p('Bild und Ton gehen Ende-zu-Ende-verschlüsselt direkt zwischen den Teilnehmenden (Peer-to-Peer). Die Inhalte des Gesprächs erreichen den Server nicht und werden nirgends aufgezeichnet. Der Server vermittelt nur den Verbindungsaufbau; dafür verarbeitet er Ihre IP-Adresse und eine zufällige Kennung des Gesprächsraums, solange das Gespräch dauert. Gesprächsräume bestehen nur im Arbeitsspeicher und verschwinden mit dem Ende des Gesprächs.'));
  if (f.stun.length) {
    const hosts = [...new Set(f.stun.map(host))];
    const dritt = hosts.filter((h) => DRITTLAND.test(h));
    teile.push(p(`Damit sich die Geräte finden, fragt Ihr Browser einen STUN-Server nach seiner öffentlichen IP-Adresse: ${hosts.map(esc).join(', ')}. Der Betreiber dieses Servers erhält dabei Ihre IP-Adresse.${dritt.length ? ` ${dritt.map(esc).join(', ')} ${dritt.length > 1 ? 'werden' : 'wird'} von einem Unternehmen mit Sitz außerhalb der EU betrieben; Ihre IP-Adresse kann dabei in ein Drittland übermittelt werden.` : ''}`));
  }
  if (f.turn.art === 'eigen') {
    teile.push(p(`Lässt Ihr Netz keine direkte Verbindung zu, läuft das verschlüsselte Gespräch über einen Relay-Server des Betreibers (${esc(f.turn.host)}). Er sieht die IP-Adressen, nicht die Inhalte.`));
  } else if (f.turn.art === 'oeffentlich') {
    teile.push(p('Lässt Ihr Netz keine direkte Verbindung zu, läuft das verschlüsselte Gespräch über ein öffentliches Relay (openrelay.metered.ca), betrieben von einem Unternehmen mit Sitz außerhalb der EU. Es sieht die IP-Adressen, nicht die Inhalte.'));
  }

  // 5. Identity check
  if (f.verifier) {
    const attrs = f.attributes.map((a) => ATTR_LABEL[a] || a);
    teile.push('<h2>Identitätsprüfung mit der EUDI-Wallet</h2>');
    teile.push(p(`Vor dem Gespräch weisen sich die Teilnehmenden mit ihrer EUDI-Wallet aus. Angefragt werden können: ${attrs.map(esc).join(', ')}. Was die Wallet übermittelt, entscheiden Sie dort selbst; ohne Ihre Freigabe wird nichts übertragen. Die geprüften Angaben sieht nur die andere Seite des Gesprächs, und nur für dessen Dauer.`));
    teile.push(p(`Geprüft wird über einen Verifier-Dienst des Betreibers (${esc(f.verifier)}). Er prüft die Echtheit der Angaben; die Software löscht die Prüfsitzung samt der vorgezeigten Angaben dort unmittelbar nach der Prüfung. Auf dem Server dieser Instanz werden keine Ausweisangaben gespeichert. Für den Nachweis, dass Prüfungen ordnungsgemäß liefen, schreibt die Software ein Betriebsprotokoll: wann eine Prüfung stattfand, welche Arten von Angaben angefragt wurden und ob sie gelang — ohne die Angaben selbst und ohne Namen; Raumkennungen stehen darin nur als Einweg-Prüfsumme, deren Schlüssel bei jedem Neustart wechselt, Teilnehmende nur als zufällige Verbindungskennung.`));
  }

  // 6. What depends on how the instance is used
  const weiteres: string[] = [];
  if (f.invites) weiteres.push('<strong>Terminlinks.</strong> Einladungen zu einem Termin sind signierte Links; was angefragt wird und wann der Termin gilt, steht im Link selbst. Auf dem Server wird dafür nichts gespeichert.');
  if (f.hostList) weiteres.push('<strong>Wer einladen darf.</strong> Die Instanz führt eine Liste der Namen der Personen, die Gespräche leiten dürfen, und vergleicht sie mit dem geprüften Namen aus der Wallet. Gäste betrifft das nicht.');
  if (f.inCallCredentials) weiteres.push('<strong>Weitere Nachweise.</strong> Während des Gesprächs kann die leitende Person weitere Nachweise aus Ihrer Wallet anfragen. Sie entscheiden in der Wallet, ob Sie sie vorzeigen; sie werden behandelt wie die Identitätsprüfung oben.');
  if (f.usage) weiteres.push('<strong>Gesprächsminuten.</strong> Die Software zählt je Kalendermonat, wie viele Gespräche stattfanden und wie lange sie insgesamt dauerten — ohne Kennungen, Namen, IP-Adressen oder Uhrzeiten einzelner Gespräche.');
  if (weiteres.length) {
    teile.push('<h2>Je nach Nutzung</h2>');
    teile.push(...weiteres.map(p));
  }

  // 7. Modules
  for (const m of f.modules) {
    if (m.privacy) {
      teile.push(`<h2>${esc(m.privacy.title)}</h2>`);
      teile.push(...m.privacy.text.split(/\n\s*\n/).map((t) => p(esc(t.trim()))));
    } else {
      teile.push(`<h2>Zusatzmodul ${esc(m.id)}</h2>`);
      teile.push(p(`Diese Instanz nutzt das Zusatzmodul „${esc(m.id)}“ (${m.titles.map(esc).join(', ') || 'ohne Beschreibung'}). Sein Hersteller hat keine Angaben zur Datenverarbeitung hinterlegt; fragen Sie im Zweifel den Verantwortlichen oben.`));
    }
  }

  // 8. The visitor's device
  teile.push('<h2>Auf Ihrem Gerät</h2>');
  teile.push(p('Es gibt keine Cookies, kein Nutzerkonto, keine Werbung und keine Analysewerkzeuge. Schriftarten liefert der Server selbst aus. Im Speicher Ihres Browsers bleiben nur Ihre Einstellungen für Sprache und Darstellung sowie, wenn Sie einen Termin anlegen, der Link für Ihren Gast — auf Ihrem Gerät, nicht auf dem Server.'));

  // 9. Rights
  teile.push('<h2>Ihre Rechte</h2>');
  teile.push(p(`Sie haben das Recht auf Auskunft (Art. 15 DSGVO), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21). Wenden Sie sich dafür an den Verantwortlichen oben.${d.rechtsgrundlage === 'einwilligung' ? ' Eine Einwilligung können Sie jederzeit mit Wirkung für die Zukunft widerrufen.' : ''} Sie können sich außerdem bei einer Datenschutz-Aufsichtsbehörde beschweren (Art. 77 DSGVO)${d.aufsicht ? `, zuständig ist: ${esc(d.aufsicht)}` : ''}.`));

  if (d.stand) {
    const [y, mo, da] = d.stand.split('-');
    teile.push(p(`<small>Stand: ${da}.${mo}.${y}</small>`));
  }

  return placeholder
    .replace(/<!-- privacy:start[\s\S]*?<!-- privacy:end -->/, () => teile.join('\n      '))
    .replace(/(<meta name="description" content=")[^"]*(")/, (_m, a, b) => `${a}Datenschutzerklärung${imprint ? `: ${esc(imprint.name)}` : ''}${b}`);
}
