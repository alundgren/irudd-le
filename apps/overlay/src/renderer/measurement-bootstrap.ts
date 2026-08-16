/**
 * A nonce-bound script for an opaque published iframe. It is kept separate so
 * its observable message contract can be exercised without trusting authored
 * content or widening the iframe sandbox origin.
 */
export function measurementBootstrap(measurementToken: string): string {
  const token = JSON.stringify(measurementToken);
  return `const fail=error=>parent.postMessage({type:'overlay:render-failure',token:${token},error:error instanceof Error?error.message:'Staged image failed to load'},'*');const settle=async()=>{const waitForImage=image=>image.complete?image.decode():new Promise((resolve,reject)=>{image.addEventListener('load',resolve,{once:true});image.addEventListener('error',()=>reject(new Error('Staged image failed to load')),{once:true})});await Promise.all([...document.images].map(waitForImage));if(document.fonts)await document.fonts.ready;requestAnimationFrame(()=>parent.postMessage({type:'overlay:render-metrics',token:${token},metrics:{width:document.documentElement.clientWidth,height:document.documentElement.clientHeight,scrollWidth:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),scrollHeight:Math.max(document.documentElement.scrollHeight,document.body.scrollHeight)}},'*'))};void settle().catch(fail)`;
}
