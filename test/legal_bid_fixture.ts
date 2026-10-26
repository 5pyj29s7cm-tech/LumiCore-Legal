/** SDK fixture follows the request transport; long generation emits empty heartbeat frames. */
export function sdkCompletion(params: any, completion: any, delayMs = 0, signal?: AbortSignal): any {
  if (!params.stream) return completion;
  return (async function* () {
    yield { choices: [{ delta: {} }] };
    for (let elapsed = 0; elapsed < delayMs;) {
      const step = Math.min(10000, delayMs - elapsed);
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, step);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason || new Error('cancelled')); };
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once:true});
      });
      elapsed += step;
      if (elapsed < delayMs) yield { choices: [{ delta: {} }] };
    }
    yield { choices: completion.choices.map((choice:any,index:number)=>({index,delta:choice.message,finish_reason:choice.finish_reason})), ...(completion.usage?{usage:completion.usage}:{}) };
  })();
}
