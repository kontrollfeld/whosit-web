// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How the call setup looks on one instance — the operator's choice, not the software's.
 *
 * The attributes an instance may ask for are fixed by its WRP policy (./wrp-policy). Which of them
 * are ticked when the setup opens, which quick picks sit above the list and what the other side is
 * called ("Gast", or "Mietinteressent" on a letting agent's instance) depend on who runs it. So,
 * like the imprint (./operator-pages), the operator puts a file next to their pages:
 *
 *   <EUDI_OPERATOR_PAGES>/oberflaeche.json
 *   {
 *     "vorauswahl":  { "anfragen": ["given_name", "family_name"], "teilen": ["family_name"] },
 *     "schnellwahl": [ { "name": { "de": "Nur Name", "en": "Name only" }, "angaben": ["given_name", "family_name"] } ],
 *     "texte":       { "de": { "Gast": "Kundin" }, "en": { "Gast": "Customer" } }
 *   }
 *
 * Every part is optional. Read per request: a changed file needs no restart.
 *
 * What it cannot do. It never widens anything: attributes outside the policy are dropped here
 * before the client sees them, and the server refuses them in a call anyway. `texte` replaces the
 * German source strings of the interface (keys as in public/translations.json) — plain text only:
 * a value with markup characters makes the whole file invalid, so an override can never become
 * HTML, not even where the client inserts a dictionary entry as markup. An invalid file is not
 * half-applied; it is ignored as a whole, and the reason is logged and published as `fehler`.
 */
import fs from 'fs';
import path from 'path';

export interface OperatorUi {
  vorauswahl?: { anfragen?: string[]; teilen?: string[] };
  schnellwahl?: { name: Record<string, string>; angaben: string[] }[];
  texte?: Record<string, Record<string, string>>;
}

const ATTR = /^[a-z][a-z0-9_]{0,39}$/;
const LOCALE = /^[a-z]{2}$/;
/** One line of plain text: no control characters, nothing a browser would read as markup. */
const TEXT = /^[^\u0000-\u001f\u007f<>&]{1,200}$/;
/** A dictionary key is the client's German source string — longer, but just as plain. */
const KEY = /^[^\u0000-\u001f\u007f<>]{1,400}$/;
const MAX_SCHNELLWAHL = 4;
const MAX_TEXTE = 80;

const istListe = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && ATTR.test(x));

/**
 * The file's content checked against the attributes this instance may ask for. Attributes outside
 * them are dropped (a narrowed instance keeps a file written for its wider policy usable); a quick
 * pick left empty by that is dropped too. Everything else that is off makes the file invalid.
 */
export function parseOperatorUi(raw: unknown, erlaubt: readonly string[]): { ui: OperatorUi } | { fehler: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { fehler: 'kein JSON-Objekt' };
  const o = raw as Record<string, unknown>;
  const unbekannt = Object.keys(o).filter((k) => !['vorauswahl', 'schnellwahl', 'texte'].includes(k));
  if (unbekannt.length) return { fehler: `unbekannte Felder: ${unbekannt.join(', ')}` };
  const nurErlaubte = (l: string[]) => [...new Set(l.filter((a) => erlaubt.includes(a)))];
  const ui: OperatorUi = {};

  if (o.vorauswahl !== undefined) {
    const v = o.vorauswahl as Record<string, unknown>;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { fehler: 'vorauswahl ist kein Objekt' };
    const fremd = Object.keys(v).filter((k) => k !== 'anfragen' && k !== 'teilen');
    if (fremd.length) return { fehler: `vorauswahl: unbekannte Felder: ${fremd.join(', ')}` };
    ui.vorauswahl = {};
    for (const seite of ['anfragen', 'teilen'] as const) {
      if (v[seite] === undefined) continue;
      if (!istListe(v[seite])) return { fehler: `vorauswahl.${seite} ist keine Liste von Attributnamen` };
      ui.vorauswahl[seite] = nurErlaubte(v[seite] as string[]);
    }
  }

  if (o.schnellwahl !== undefined) {
    if (!Array.isArray(o.schnellwahl)) return { fehler: 'schnellwahl ist keine Liste' };
    if (o.schnellwahl.length > MAX_SCHNELLWAHL) return { fehler: `höchstens ${MAX_SCHNELLWAHL} Schnellwahlen` };
    ui.schnellwahl = [];
    for (const [i, s] of (o.schnellwahl as unknown[]).entries()) {
      const e = s as Record<string, unknown>;
      if (!e || typeof e !== 'object' || Array.isArray(e)) return { fehler: `schnellwahl[${i}] ist kein Objekt` };
      const n = e.name as Record<string, unknown>;
      if (!n || typeof n !== 'object' || Array.isArray(n) || typeof n.de !== 'string') return { fehler: `schnellwahl[${i}].name braucht mindestens "de"` };
      const name: Record<string, string> = {};
      for (const [l, t] of Object.entries(n)) {
        if (!LOCALE.test(l) || typeof t !== 'string' || !TEXT.test(t.trim())) return { fehler: `schnellwahl[${i}].name.${l} ist kein einzeiliger Text ohne < > &` };
        name[l] = t.trim();
      }
      if (!istListe(e.angaben)) return { fehler: `schnellwahl[${i}].angaben ist keine Liste von Attributnamen` };
      const angaben = nurErlaubte(e.angaben as string[]);
      if (angaben.length) ui.schnellwahl.push({ name, angaben });
    }
  }

  if (o.texte !== undefined) {
    const t = o.texte as Record<string, unknown>;
    if (!t || typeof t !== 'object' || Array.isArray(t)) return { fehler: 'texte ist kein Objekt' };
    ui.texte = {};
    let anzahl = 0;
    for (const [l, tabelle] of Object.entries(t)) {
      if (!LOCALE.test(l)) return { fehler: `texte: „${l.slice(0, 10)}“ ist kein Sprachkürzel` };
      if (!tabelle || typeof tabelle !== 'object' || Array.isArray(tabelle)) return { fehler: `texte.${l} ist kein Objekt` };
      ui.texte[l] = {};
      for (const [quelle, ersatz] of Object.entries(tabelle as Record<string, unknown>)) {
        if (++anzahl > MAX_TEXTE) return { fehler: `höchstens ${MAX_TEXTE} Texte` };
        if (!KEY.test(quelle)) return { fehler: `texte.${l}: ungültiger Schlüssel` };
        if (typeof ersatz !== 'string' || !TEXT.test(ersatz.trim())) return { fehler: `texte.${l}["${quelle.slice(0, 40)}"] ist kein einzeiliger Text ohne < > &` };
        ui.texte[l][quelle.replace(/\s+/g, ' ').trim()] = ersatz.trim();
      }
    }
  }
  return { ui };
}

/** The file from the operator's directory, or null when there is none. Read per request. */
export function readOperatorUi(dir: string | null, erlaubt: readonly string[]): { ui: OperatorUi } | { fehler: string } | null {
  if (!dir) return null;
  let text: string;
  try { text = fs.readFileSync(path.join(dir, 'oberflaeche.json'), 'utf8'); } catch { return null; }
  try { return parseOperatorUi(JSON.parse(text), erlaubt); } catch { return { fehler: 'kein gültiges JSON' }; }
}
