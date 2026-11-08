"""Attach a hash-bound, versioned model visual review to a NEW application draft."""
import hashlib
import json
from pathlib import Path

from extraction import extract_bytes, PARSER
from documents import LIMIT
from template_comparison import units
from template_context import matching_evidence

REVIEW = Path(__file__).resolve().parents[2] / 'references/whole-form-wave-one-v1.json'


def attach_whole_form(result, source, reference, review_id, output, specification=None):
    spec = specification if specification is not None else json.loads(REVIEW.read_text(encoding='utf-8'))
    if review_id != spec['review_id'] or spec['reference_sha256'] != reference['snapshot']['sha256'] or spec['parser_version'] != PARSER:
        raise ValueError('Whole-form review reference/version mismatch')
    selected = spec['hospitals'].get(result['hospital_key'])
    if not selected or selected['source_sha256'] != source['snapshot']['sha256']:
        raise ValueError('Whole-form review does not cover this application snapshot')
    if selected['result'] != 'unclear':
        raise ValueError('This interpretation record cannot approve or promote a finding')
    app, ref = units(source, 'application'), units(reference, 'reference')
    app_index = {e['evidence_id']: e for e in app}
    coverage = []
    for entry in ref:
        exception = selected['exceptions'].get(entry['evidence_id'])
        if exception:
            try:
                matches = [app_index[eid] for eid in exception['application_ids']]
            except KeyError as error:
                raise ValueError('Whole-form evidence ID mismatch') from error
        else:
            matches = matching_evidence(entry['quote'], app)
        if not matches:
            raise ValueError('Whole-form record leaves reference content unaccounted for')
        coverage.append(dict(reference_evidence=entry, application_evidence=matches,
                             interpretation=exception['reason'] if exception else 'Normalized text correspondence; also covered by visual section review.'))
    if set(selected['exceptions']) - {e['evidence_id'] for e in ref}:
        raise ValueError('Whole-form exception has no reference evidence')

    render_evidence, renders = [], {}
    for role, render, original in [('reference', spec['reference_render'], reference['snapshot']),
                                   ('application', selected['application_render'], source['snapshot'])]:
        digest = render['sha256']
        if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError('Invalid render hash')
        path = output / 'snapshots' / f'{digest}.pdf'
        if not path.resolve().is_relative_to(output.resolve()) or path.stat().st_size > LIMIT:
            raise ValueError('Render path is outside snapshot storage')
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError('Rendered PDF hash mismatch')
        pages = extract_bytes(raw, '.pdf')
        if len(pages) != render['pages'] or any(p['status'] != 'extracted' for p in pages):
            raise ValueError('Rendered PDF page coverage mismatch')
        if not render['derived'] and digest != original['sha256']:
            raise ValueError('Original-PDF review must match the source snapshot')
        label = f"{role.title()} — " + ('local Word rendering (derived PDF)' if render['derived'] else 'original hospital PDF')
        snapshot = dict(snapshot_id=digest, sha256=digest, artifact_path=f'snapshots/{digest}.pdf',
            url=original['url'], retrieved_at=original['retrieved_at'], publisher_updated_at=None,
            document_type='supplement', display_name=label,
            derived_from_snapshot_id=original['snapshot_id'] if render['derived'] else None,
            render_engine=render['engine'], render_review_date=spec['reviewed_at'])
        if not any(s['snapshot_id'] == digest for s in result['snapshots']):
            result['snapshots'].append(snapshot)
        renders[role] = dict(snapshot_id=digest, pages=len(pages), label=label, engine=render['engine'])
        for page in pages:
            first_line = next(line for line in page['text'].splitlines() if line.strip())
            render_evidence.append(dict(snapshot_id=digest, locator=page['locator'], quote=first_line))
        result['coverage'].append(dict(source_id=f'{role}_visual_review', url=original['url'], language='English',
            status='model_visual_review', total_pages=len(pages), reviewed_pages=[p['locator'] for p in pages],
            snapshot_id=digest, locator_unit='rendered PDF pages', notes=label + '. ' + render['engine']))

    for section in selected['visual_sections']:
        for role in ('reference', 'application'):
            if not section[f'{role}_pages'] or any(not 1 <= p <= renders[role]['pages'] for p in section[f'{role}_pages']):
                raise ValueError('Visual section refers to an invalid rendered page')
    for role in ('reference', 'application'):
        if set(range(1, renders[role]['pages'] + 1)) != {p for s in selected['visual_sections'] for p in s[f'{role}_pages']}:
            raise ValueError('Visual section review leaves pages uncovered')

    context = result['template_comparison']
    context['whole_form_review'] = dict(review_id=review_id, reviewed_at=spec['reviewed_at'], reviewer=spec['reviewer'],
        result='unclear', conclusion=selected['conclusion'], recommendation=selected['recommendation'],
        resolved_points=spec['resolved_points'], authority=spec['authority'], limitations=spec['limitations'],
        renders=renders, visual_sections=selected['visual_sections'], reference_units_reviewed=len(coverage),
        content_coverage=coverage, human_review='pending')
    context['unresolved_questions'] = selected['questions']
    context['observations'].append(dict(kind='model_visual_review', title='Rendered whole-form review: every page inspected',
        explanation=selected['conclusion'] + ' Page-opening quotes below link the reviewed visual artifacts; they are not a substitute for the visual section matrix.',
        evidence=render_evidence))
    finding = next(f for f in result['findings'] if f['measure_id'] == 'application.uniform_application')
    finding.update(explanation=selected['conclusion'], unresolved_questions=selected['questions'])
    finding['evidence'].extend(render_evidence)
