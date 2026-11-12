import {criterionStatus, requestedSteps} from './criterion-service.js';

const latestDate = values => values.filter(value => value && Number.isFinite(Date.parse(value)))
  .sort((a,b)=>Date.parse(b)-Date.parse(a))[0] ?? null;

// Reporting uses a read-only SQLite transaction. Do not migrate or expire jobs here.
export function criterionOperations(db) {
  if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='criterion_jobs'").get() ||
      !db.prepare("SELECT 1 FROM sqlite_master WHERE name='criterion_results'").get()) return new Map();
  const jobs=db.prepare('SELECT * FROM criterion_jobs ORDER BY created DESC,rowid DESC').all();
  const keys=new Set([...jobs.map(j=>j.hospital),...db.prepare('SELECT DISTINCT hospital FROM criterion_results').all().map(r=>r.hospital)]);
  return new Map([...keys].map(key=>{
    const hospitalJobs=jobs.filter(j=>j.hospital===key);
    const status=criterionStatus(db,key,{readOnly:true});
    const latest=hospitalJobs[0];
    const latestState=status.items.find(item=>item.latest?.id===latest?.id)?.latest;
    return [key,{
      runs:hospitalJobs.length,
      latest:latest ? {id:latest.id,source:'criterion',status:latestState?.status ?? latest.status,requested:requestedSteps(latest),
        queued_at:latest.created,attempted_at:latest.started,completed_at:latestState?.completed ?? latest.completed} : null,
      summary:status.summary,
      clocks:{last_attempted:latestDate(hospitalJobs.map(j=>j.started)),
        last_completed_execution:latestDate(hospitalJobs.filter(j=>j.status==='completed').map(j=>j.completed)),
        last_successful_source_retrieval:latestDate(status.items.flatMap(i=>(i.saved?.evidence ?? []).map(e=>e.retrievedAt))),
        next_due_at:null},
    }];
  }));
}

export function combineOperations(legacy,current) {
  if (!current) return {...legacy,latest:legacy.latest ? {...legacy.latest,source:'legacy'} : null,criterion:null};
  const old=legacy.latest;
  const newest=current.latest && (!old || Date.parse(current.latest.queued_at) >= Date.parse(old.queued_at ?? old.attempted_at ?? 0));
  return {...legacy,
    latest:newest ? current.latest : old ? {...old,source:'legacy'} : null,
    clocks:{...legacy.clocks,
      last_attempted:latestDate([legacy.clocks.last_attempted,current.clocks.last_attempted]),
      last_completed_execution:latestDate([legacy.clocks.last_completed_execution,current.clocks.last_completed_execution]),
      last_successful_source_retrieval:latestDate([legacy.clocks.last_successful_source_retrieval,current.clocks.last_successful_source_retrieval]),
      next_due_at:newest ? null : legacy.clocks.next_due_at},
    // Old receipts do not describe a new requirement check's spending.
    cost_status:newest ? 'not_recorded' : legacy.cost_status,
    criterion:current,legacy:{latest:old,clocks:legacy.clocks,cost_status:legacy.cost_status},
  };
}
