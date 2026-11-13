import React, {useRef,useState} from 'react';
import {useLocale} from './locale.jsx';
import {notifyCriterionChange} from './CriterionCoverage.jsx';

export default function CriterionDecision({item,hospitalKey,disabled,onSaved}) {
  const {t,language}=useLocale();
  const [decision,setDecision]=useState('unclear'),[reason,setReason]=useState(''),[evidence,setEvidence]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(null);
  const request=useRef(null),lock=useRef(false);
  const labels={met:'Condition met',unmet:'Condition not met',unclear:'Still unclear'};
  function edit(setter,value){request.current=null;setError(null);setter(value);}
  async function submit(event) {
    event.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setError(null);
    const payload=request.current ?? {request_key:crypto.randomUUID(),revision:item.revision,decision,reason,evidence};
    request.current=payload;
    try {
      const response=await fetch(`/api/hospitals/${hospitalKey}/criteria/${item.id}/decisions`,{
        method:'POST',headers:{'Content-Type':'application/json','X-Review-Request':'1'},body:JSON.stringify(payload),
      });
      if(!response.ok) {setError(response.status===409?'The audit changed. Refresh before deciding.':'Decision could not be saved. Retry the same decision.');return;}
      request.current=null;setReason('');setEvidence('');onSaved();notifyCriterionChange();
    } catch {setError('Decision could not be saved. Retry the same decision.');}
    finally {lock.current=false;setBusy(false);}
  }
  return <details className="criterion-human-review">
    <summary>{t('Human review and decision history')}</summary>
    <p>{t('Review the source citations before deciding. The original agent finding is retained. No reviewer identity is collected for this demo.')}</p>
    <form onSubmit={submit}>
      <fieldset disabled={busy||disabled}>
        <legend>{t('Record a human decision')}</legend>
        <label>{t('Decision')}<select value={decision} onChange={e=>edit(setDecision,e.target.value)}>
          {Object.entries(labels).map(([value,label])=><option key={value} value={value}>{t(label)}</option>)}
        </select></label>
        <label>{t('Reason')}<textarea required maxLength={2000} value={reason} onChange={e=>edit(setReason,e.target.value)} /></label>
        <label>{t('Supporting evidence: source URL, page and quotation')}<textarea required={decision!=='unclear'} maxLength={4000} value={evidence} onChange={e=>edit(setEvidence,e.target.value)} /></label>
        <button type="submit">{t(busy?'Saving decision…':'Save human decision')}</button>
      </fieldset>
    </form>
    {error && <p role="alert">{t(error)}</p>}
    <ol>{(item.history ?? []).map(record=><li key={record.id}>
      <strong>{t(labels[record.decision])} · {t('Decision recorded')}: {new Date(record.decided_at).toLocaleString(language)}</strong>
      {!record.current && <p>{t('Historical decision; superseded or evidence changed.')}</p>}
      <p lang="und">{record.reason}</p><blockquote lang="und">{record.evidence}</blockquote>
      <details><summary>{t('Evidence reviewed at that time')}</summary>
        <p lang="en">{record.reviewed_result?.saved?.explanation}</p>
        {(record.reviewed_result?.saved?.evidence ?? []).map((source,index)=><blockquote key={index} lang="und">{source.sourceUrl} · {source.locator} · {source.quote}</blockquote>)}
      </details>
    </li>)}</ol>
  </details>;
}
