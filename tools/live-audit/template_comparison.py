"""Reproducible text alignment with a pinned official NYS form; not equivalence approval."""
import difflib
import hashlib
import re
import uuid
from pathlib import Path
import json
import zipfile
from functools import lru_cache
from datetime import datetime

from cross_documents import load_sources, identifier
from documents import now
from extraction import extract_bytes, PARSER
from full_review import json_save
from playwright.sync_api import sync_playwright
from documents import LIMIT

REFERENCE_URL = "https://www.health.ny.gov/facilities/hospital/financial_assist/hosp_info/docs/2026_uniform_financial_assistance_application.docx"
AUTHORITY_URL = "https://www.health.ny.gov/facilities/hospital/financial_assist/hosp_info/"

# Source-language anchors are structural coverage only, never a translation-equivalence test.
COMPONENTS = {
    'patient_fields': ['Patient Name', 'Nombre del paciente', 'Imię i nazwisko pacjenta', 'Дані пацієнта', 'Имя и фамилия пациента'],
    'family_income': ['Family Information', '(?:Información de la familia|Información familiar)', 'Informacje o rodzinie', 'Інформація про членів родини', 'Информация о семье'],
    'insurance': ['Health Insurance Status', 'Estado del seguro médico', 'Status ubezpieczenia zdrowotnego', 'Статус медичного страхування', 'Статус медицинского страхования'],
    'declaration': ['I certify', '(?:Declaro|Certifico)', 'Potwierdzam', 'Я підтверджую', 'Я подтверждаю'],
    'signature': ['^Signature\\s*$', '^Firma\\s*$', '^Podpis\\s*$', '^Підпис\\s*$', '^Подпись\\s*$'],
    'rights_instructions': ['Application Timeline', '(?:Línea de tiempo de la solicitud|Plazos de solicitud)', 'Ramy czasowe wniosku', 'Терміни подання заявки', 'Сроки подачи заявления'],
    'income_table': ['Federal Poverty Levels', '(?:Nivel federal de pobreza|Niveles federales de pobreza)', 'Federalne progi ubóstwa', 'Федеральний прожитковий мінімум', 'Федеральный уровень бедности'],
    'discount_table': ['Minimum Discount Rates', '(?:Tarifas mínimas de descuento|Tasas de descuento mínimo)', 'Minimalne stawki obniżenia', 'Мінімальні облікові ставки', 'Минимальный размер скидки'],
    'installments': ['Installment Plans', '(?:Plan de pago en cuotas|Planes de pago a plazos)', 'Plany spłaty ratalnej', 'Надання розстрочки', 'Оплата по частям'],
    'income_documentation': ['Request for Proof of Household Income', 'Solicitud de prueba de ingresos', 'Żądanie dostarczenia dokumentu', 'Запит на підтвердження доходу', 'Запрос на подтверждение дохода'],
    'language_disclosure': ['[Pp]rimary languages', 'Idiomas principales|idiomas principales', 'Główne języki', 'Основна мова', 'Основные языки']
}
FIELDS = {
    'birth_date': ['Date of Birth', 'Fecha de nacimiento', 'Data urodzenia', 'Дата народження', 'Дата рождения'],
    'address': ['Address', 'Dirección', 'Adres', 'Адреса', 'Адрес'],
    'telephone': ['Contact Phone', 'Teléfono de contacto|N.º de teléfono de contacto', 'Telefon', 'Номер телефону', 'Контактный номер телефона'],
    'guardian': ['Parent/Guardian|Parent / Guardian', 'padre/madre/tutor|padre, la madre, el tutor', 'rodzica/opiekuna', 'батька/матері/опікуна', 'родителя / опекуна'],
    'email': ['Email', 'correo electrónico', 'e-mail', 'Електронна адреса', 'Электронная почта'],
    'gross_income_definition': ['Gross income means', 'Ingreso bruto significa|El ingreso bruto es', 'Dochód brutto oznacza', 'Валовий дохід', 'Валовой доход'],
    'paid_medical_expenses': ['past 12 months', 'últimos 12 meses', 'ostatnich 12 miesięcy', 'останні 12 місяців', 'последние 12 месяцев'],
    'external_verification': ['external sources', 'fuentes externas', 'podmioty zewnętrzne', 'сторонні особи', 'внешними источниками'],
    'signer_relationship': ['Relationship to Patient', 'Relación con el paciente', 'Stosunek prawny do pacjenta', 'Ким приходиться пацієнту', 'Кем приходится пациенту'],
    'no_income_option': ['No Income', 'Sin ingresos', 'Brak dochodów', 'Без доходу', 'Отсутствие дохода']
}


def component_review(source, reference, language):
    """Cite structural anchors against original reference; nonmatches remain unknown."""
    index = ['en', 'es', 'pl', 'uk', 'ru'].index(language)
    def locate(segments, pattern):
        return [dict(locator=p['locator'], quote=p['text']) for p in segments
                if p['status'] == 'extracted' and (re.search(pattern, p['text'], re.I | re.M) or re.search(pattern, re.sub(r'\s+', ' ', p['text']), re.I))]
    return dict(language=language, semantic_equivalence='unverified', customization_rule='unresolved',
        components=[dict(component=name, status='present_anchor' if locate(source, patterns[index]) else 'not_established',
                         hospital_evidence=locate(source, patterns[index]), reference_evidence=locate(reference, patterns[0]))
                    for name, patterns in {**COMPONENTS, **FIELDS}.items()],
        limitations=['Anchors establish component presence only, not completeness of every field or disclosure.',
                     'No missing component is asserted solely from a pattern nonmatch.',
                     'Authoritative translated-template applicability, semantic equivalence and permitted customization remain human-review questions.'])


@lru_cache(maxsize=1)
def offline_template():
    root = Path(__file__).resolve().parents[2]
    spec = json.loads((root / 'references/whole-form-wave-one-v1.json').read_bytes())
    with zipfile.ZipFile(root / 'docs/validation/application-reference-evidence.zip') as archive:
        capture = json.loads(archive.read('reference-captures/9d1674693c5249fa854b159cf2010f3a.json'))
        if capture['snapshot']['sha256'] != spec['reference_sha256'] or capture['reference_url'] != REFERENCE_URL:
            raise ValueError('Unpinned official template capture')
        def verified(path, digest):
            if archive.getinfo(path).file_size > LIMIT:
                raise ValueError('Reference byte limit')
            data = archive.read(path)
            if hashlib.sha256(data).hexdigest() != digest:
                raise ValueError('Reference checksum mismatch')
            return data
        original = verified(capture['snapshot']['artifact_path'], spec['reference_sha256'])
        for render in [spec['reference_render'], *(h['application_render'] for h in spec['hospitals'].values())]:
            verified('snapshots/' + render['sha256'] + '.pdf', render['sha256'])
    return dict(snapshot=capture['snapshot'], segments=extract_bytes(original, '.docx')), spec


def application_template_context(source, hospital, language):
    official, spec = offline_template()
    if language not in ['en', 'es', 'pl', 'uk', 'ru']:
        return dict(status='unsupported_language', result='unclear')
    context = component_review(source['segments'], official['segments'], language)
    context['reference_snapshot'] = official['snapshot']
    prior = spec['hospitals'].get(hospital)
    context['preserved_english_visual_review'] = prior if prior and prior['source_sha256'] == source['snapshot']['sha256'] else None
    context['result'] = 'unclear'
    context['drawings'] = [d for p in source['segments'] for d in p.get('drawings', [])]
    return context


def attach_application_context(findings, context):
    """Update only a newly computed draft; preserved producer records are never edited."""
    uniform = next(f for f in findings if f['measure_id'] == 'application.uniform_application')
    prior = context.get('preserved_english_visual_review')
    uniform.update(result='unclear', reason_code='insufficient_evidence',
        explanation=prior['conclusion'] if prior else 'Source-language structural components are cited; translated semantic equivalence, layout and customization rules remain unverified.',
        unresolved_questions=prior['questions'] if prior else context.get('limitations', ['Review unsupported language.']))


def fetch_reference(url, host):
    """Network fallback; an explicitly imported browser capture avoids blocked clients."""
    if url != REFERENCE_URL or host != "health.ny.gov":
        raise ValueError("Unapproved reference")
    with sync_playwright() as playwright:
        request = playwright.request.new_context()
        try:
            response = request.get(url, timeout=30000, max_redirects=0)
            if response.status != 200:
                raise ValueError(f"Official reference retrieval failed: HTTP {response.status}")
            if int(response.headers.get("content-length", "0")) > LIMIT:
                raise ValueError("Reference exceeds size limit")
            data = response.body()
            if len(data) > LIMIT:
                raise ValueError("Reference exceeds size limit")
            return data, response.url, response.headers.get("content-type", "")
        finally:
            request.dispose()


def import_browser_reference(filename, source_url, expected_sha256, retrieved_at, root, output, save):
    """Import a session-observed official download, not an independently re-fetched source."""
    if source_url != REFERENCE_URL or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
        raise ValueError("Pinned official URL and observed SHA-256 required")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*\.docx", filename):
        raise ValueError("Use the browser download basename only")
    timestamp = datetime.fromisoformat(retrieved_at.replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        raise ValueError("Browser retrieval timestamp requires timezone")
    directory = root / ".playwright-mcp"
    path = directory / filename
    if not path.resolve().is_relative_to(directory.resolve()) or path.stat().st_size > LIMIT:
        raise ValueError("Invalid browser download path or size")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError("Browser download hash mismatch")
    segments = extract_bytes(data, ".docx")
    if not any("NYS Uniform Hospital Financial Assistance Application" in s["text"] for s in segments):
        raise ValueError("Downloaded reference title needs review")
    relative = f"snapshots/{expected_sha256}.docx"
    save(output / relative, data)
    capture_id = uuid.uuid4().hex
    capture = dict(capture_id=capture_id, authority_url=AUTHORITY_URL, reference_url=REFERENCE_URL,
        reference_version="NYS-2026-English", imported_at=now(),
        retrieval_method="session-confirmed official browser download; not re-fetched at import",
        browser_download_filename=filename,
        snapshot=dict(snapshot_id=expected_sha256, sha256=expected_sha256, artifact_path=relative,
                      url=REFERENCE_URL, document_type="supplement", retrieved_at=retrieved_at, publisher_updated_at=None))
    manifest = output / "reference-captures" / f"{capture_id}.json"
    json_save(manifest, capture, save)
    return dict(reference_capture_id=capture_id, result_file=str(manifest), **capture)


def captured_reference(capture_id, output):
    capture = json.loads((output / "reference-captures" / f"{identifier(capture_id)}.json").read_text(encoding="utf-8"))
    snapshot = capture["snapshot"]
    digest = snapshot["sha256"]
    if (capture["capture_id"] != capture_id or capture["reference_url"] != REFERENCE_URL
            or snapshot["url"] != REFERENCE_URL or snapshot["snapshot_id"] != digest
            or not re.fullmatch(r"[a-f0-9]{64}", digest) or snapshot["artifact_path"] != f"snapshots/{digest}.docx"):
        raise ValueError("Invalid official reference capture")
    path = output / snapshot["artifact_path"]
    if not path.resolve().is_relative_to(output.resolve()) or path.stat().st_size > LIMIT:
        raise ValueError("Invalid reference snapshot path or size")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Reference snapshot hash mismatch")
    return dict(snapshot=snapshot, segments=extract_bytes(data, ".docx")), capture["retrieval_method"]


def units(source, prefix):
    result = []
    for segment in source["segments"]:
        for line in segment["text"].splitlines():
            if line.strip():
                result.append(dict(evidence_id=f"{prefix}-{len(result) + 1}", snapshot_id=source["snapshot"]["snapshot_id"],
                                   locator=segment["locator"], quote=line))
    return result


def align(reference, application):
    # Line breaks and hospital customizations create differences too. Never grade from similarity.
    normalize = lambda s: re.sub(r"\s+", " ", s).strip().casefold()
    left, right = units(reference, "reference"), units(application, "application")
    matcher = difflib.SequenceMatcher(a=[normalize(e["quote"]) for e in left], b=[normalize(e["quote"]) for e in right], autojunk=False)
    blocks = [dict(operation=op, reference_evidence_ids=[e["evidence_id"] for e in left[a:b]],
                   application_evidence_ids=[e["evidence_id"] for e in right[c:d]])
              for op, a, b, c, d in matcher.get_opcodes()]
    return dict(reference_evidence=left, application_evidence=right, alignment=blocks,
                changed_blocks=sum(b["operation"] != "equal" for b in blocks))


def cited_text(evidence):
    """Deliver every line once; repeated JSON/source copies exceed tool-output limits."""
    text, previous = [], None
    for entry in evidence:
        if entry["locator"] != previous:
            previous = entry["locator"]
            text.append(f"SOURCE LOCATOR: {previous}")
        text.append(f"[{entry['evidence_id']}] {entry['quote']}")
    return "\n".join(text)


def compare_template(hospital_key, extraction_id, application_url, output, save, fetch=fetch_reference, reference_capture_id=None):
    sources, gaps = load_sources(hospital_key, extraction_id, output)
    selected = [s for s in sources if s["snapshot"]["url"] == application_url and s["snapshot"]["document_type"] == "application"]
    if len(selected) != 1:
        raise ValueError("Select one saved application, not a policy or summary")
    if reference_capture_id:
        reference, method = captured_reference(reference_capture_id, output)
    else:
        data, final_url, mime = fetch(REFERENCE_URL, "health.ny.gov")
        if final_url != REFERENCE_URL:
            raise ValueError("Official reference redirect needs version review")
        segments = extract_bytes(data, ".docx")
        digest = hashlib.sha256(data).hexdigest()
        relative = f"snapshots/{digest}.docx"
        save(output / relative, data)
        reference = dict(snapshot=dict(snapshot_id=digest, sha256=digest, artifact_path=relative,
            url=final_url, document_type="supplement", retrieved_at=now(), publisher_updated_at=None), segments=segments)
        method = "direct HTTPS retrieval"
    comparison_id = uuid.uuid4().hex
    packet = dict(comparison_id=comparison_id, hospital_key=hospital_key, extraction_id=extraction_id,
        extraction_parser=PARSER,
        application_url=application_url, reference_url=REFERENCE_URL, reference_version="NYS-2026-English",
        authority_url=AUTHORITY_URL, checked_at=now(), status="text_alignment_needs_human_review",
        reference_retrieval_method=method, reference_capture_id=reference_capture_id,
        human_review="pending", uniform_application_result="unclear",
        snapshots=[selected[0]["snapshot"], reference["snapshot"]],
        source_segments=selected[0]["segments"], reference_segments=reference["segments"], collection_gaps=gaps,
        limitations=["Alignment is not a determination of entire-form equivalence or legal compliance.",
                     "PDF line wrapping, DOCX table cells and hospital customization can produce text differences.",
                     "DOCX extraction covers body and listed auxiliary XML parts, not rendered pagination or visual equivalence. Check each part's extraction status.",
                     "Review required content and permitted customizations against official guidance; no draft is promoted."],
        **align(reference, selected[0]))
    path = output / "template-comparisons" / f"{comparison_id}.json"
    json_save(path, packet, save)
    return dict(result_file=str(path), comparison_id=comparison_id, hospital_key=hospital_key,
        reference_capture_id=reference_capture_id, snapshots=packet["snapshots"],
        uniform_application_result="unclear", human_review="pending", changed_blocks=packet["changed_blocks"],
        extraction_status=dict(application=[dict(locator=s["locator"], status=s["status"], reason=s.get("reason")) for s in selected[0]["segments"]],
                               reference=[dict(locator=s["locator"], status=s["status"], reason=s.get("reason")) for s in reference["segments"]]),
        limitations=packet["limitations"],
        reference_evidence_text=cited_text(packet["reference_evidence"]),
        application_evidence_text=cited_text(packet["application_evidence"]))
