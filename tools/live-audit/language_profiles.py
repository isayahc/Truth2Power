"""Source-language facts shared with the JS verifier through a versioned pattern file."""
import json
import re
from pathlib import Path

SPEC = json.loads((Path(__file__).resolve().parents[2] / 'references/application-language-profiles-v1.json').read_bytes())


def discount_rows(quote, language):
    """Link each printed income band to its own payment text; no cross-band number search."""
    text = re.sub(r'\s+', ' ', quote).strip()
    heading = 'Minimum Discount Rates' if language == 'en' else SPEC['languages'].get(language, {}).get('discount')
    if not heading or not re.search(heading, text):
        return []
    text = re.split(heading, text, maxsplit=1)[1]
    lower = re.search(r'(?:Below|Menos del|Por debajo del|Poniżej|Нижче, ніж|Ниже)\s+200\s*%', text)
    middle = re.search(r'200\s*%?\s*[-–]\s*300\s*%', text)
    upper = re.search(r'301\s*%?\s*[-–]\s*400\s*%', text)
    end = re.search(r'(?:Hospitals may|Los hospitales pueden|Szpitale mogą|Адміністрація лікарні може|Медицинские учреждения могут)', text)
    if not all((lower, middle, upper, end)) or not lower.start() < middle.start() < upper.start() < end.start():
        return []
    ranges = [(None, 200, lower.start(), middle.start()), (200, 300, middle.start(), upper.start()), (301, 400, upper.start(), end.start())]
    return [dict(lower_fpl_percent=lo, upper_fpl_percent=hi, normalized_payment_text=text[start:stop].strip(),
                 printed_payment_percentages=[int(v) for v in re.findall(r'(10|20)\s*%', text[start:stop])]) for lo, hi, start, stop in ranges]


def parse_profile(name, quote, language):
    profile = SPEC['languages'].get(language)
    if not profile:
        return None
    text = re.sub(r'\s+', ' ', quote).strip()
    if name in ('maximum', 'installments'):
        matches = re.findall(profile[name], text, re.I)
        if len(matches) != 1:
            return None
        value = float(matches[0])
        return dict(percent=value, **({'hard_ceiling': False} if name == 'maximum' else {'basis': 'gross_monthly_income'}))
    if name == 'contact':
        match = re.search(profile['contact'] + r'\(?\d{3}\)?[\s-]*\d{3}[\s-]*\d{4}\)?', text, re.I)
        return {'passage': match[0]} if match else None
    if name != 'fpl':
        return None
    headers = list(re.finditer(profile['header'], text, re.I))
    if len(headers) != 1:
        return None
    header = headers[0]
    tail = re.split(profile['discount'], text[header.end():], maxsplit=1)[0]
    if re.search(profile['nonannual'], tail, re.I):
        return None
    money = r'(\d{1,3}(?:,\d{3})+|\d+)'
    rows = list(re.finditer(r'\b(\d{1,2})\s+' + profile['row_label'] + r'\s+\$' + money + r'\s+\$' + money + r'\s+\$' + money + r'(?=\s|$)', tail))
    sizes = [int(row[1]) for row in rows]
    if not rows or len(set(sizes)) != len(sizes) or any(s < 1 for s in sizes):
        return None
    cells = [dict(household_size=int(row[1]), fpl_percent=pct, amount=int(row[i+2].replace(',', '')))
             for row in rows for i, pct in enumerate((200, 300, 400))]
    return dict(published_year=int(header[1]), currency='USD', period='annual', cells=cells)
