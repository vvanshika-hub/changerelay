/** Work is persisted before it is run. Independent instances contend through database leases. */
export function startDurableWorker({cycle,intervalMs=5000,onError=()=>{}}={}){
  if(typeof cycle!=='function'||!Number.isInteger(intervalMs)||intervalMs<100)throw new Error('A durable worker cycle and valid interval are required.');
  let stopped=false,running=null;
  async function tick(){if(stopped||running)return;running=Promise.resolve().then(cycle);try{await running;}catch{onError('The worker cycle could not finish. Persisted progress is retained.');}finally{running=null;}}
  const timer=setInterval(tick,intervalMs);timer.unref?.();
  void tick();
  return {async stop(){stopped=true;clearInterval(timer);if(running)await running.catch(()=>{});},tick};
}
