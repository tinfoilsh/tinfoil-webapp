// Clerk's timer worker, extracted verbatim from @clerk/clerk-js (see
// patches/@clerk+clerk-js+*.patch). Served from this origin so it runs under
// worker-src 'self' and is hashed like any other asset.
const respond=r=>{self.postMessage(r)},workerToTabIds={};
self.addEventListener("message",r=>{const e=r.data;
switch(e.type){case"setTimeout":workerToTabIds[e.id]=setTimeout(()=>{respond({id:e.id}),delete workerToTabIds[e.id]},e.ms);
break;
case"clearTimeout":workerToTabIds[e.id]&&(clearTimeout(workerToTabIds[e.id]),delete workerToTabIds[e.id]);
break;
case"setInterval":workerToTabIds[e.id]=setInterval(()=>{respond({id:e.id})},e.ms);
break;
case"clearInterval":workerToTabIds[e.id]&&(clearInterval(workerToTabIds[e.id]),delete workerToTabIds[e.id]);
break}});


