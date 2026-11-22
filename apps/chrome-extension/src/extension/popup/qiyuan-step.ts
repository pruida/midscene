const paths: Record<string,[string,RegExp]> = {'小红书':['www.xiaohongshu.com',/^\/search_result$/],'抖音':['www.douyin.com',/^\/search\/.+/],'知乎':['www.zhihu.com',/^\/search$/]};
function allowed(platform:string, raw:string) { const u=new URL(raw), p=paths[platform]; return !!p && u.origin==='https://'+p[0] && !u.username && !u.password && p[1].test(u.pathname); }
// This function is serialized by Chrome. Do not close over extension state.
function readPage(platform:string, expected:string, scroll:boolean) {
 const page = new URL(location.href); const safe = new URL(page.origin + page.pathname);
 for (const k of ['q','keyword','type']) for (const v of page.searchParams.getAll(k)) safe.searchParams.append(k,v);
 const pageUrl = safe.href;
 if(page.origin!==new URL(expected).origin) return {status:'ok',rows:[],pageUrl:page.origin};
 const selectors:Record<string,string>={'小红书':'section.note-item','抖音':'#search-result-container li','知乎':'.SearchResult-Card .ContentItem-title,.List-item .ContentItem-title'};
 const cards=Array.from(document.querySelectorAll<HTMLElement>(selectors[platform])).filter(c=>c.getClientRects().length&&!c.closest('aside,nav,[class*="recommend" i]'));
 if(scroll){cards.at(-1)?.scrollIntoView({block:'end'});window.scrollBy(0,innerHeight);return {status:'ok',rows:[],pageUrl};}
 const rows=[];for(const c of cards){for(const a of Array.from(c.querySelectorAll<HTMLAnchorElement>('a[href]'))){const u=new URL(a.href);const valid=platform==='小红书'?u.hostname==='www.xiaohongshu.com'&&/^\/(search_result|explore|discovery\/item)\/[a-f0-9]{24}\/?$/i.test(u.pathname):platform==='抖音'?u.hostname==='www.douyin.com'&&/^\/(video|note)\/\d+\/?$/.test(u.pathname):(u.hostname==='zhuanlan.zhihu.com'&&/^\/p\/\d+\/?$/.test(u.pathname)||u.hostname==='www.zhihu.com'&&/^\/question\/\d+\/answer\/\d+\/?$/.test(u.pathname));if(!valid||u.protocol!=='https:')continue;
 const lines=a.innerText.split(/\n+/).map(x=>x.trim());const title=platform==='小红书'?c.querySelector<HTMLElement>('.title')?.innerText:platform==='抖音'?lines.slice(0,lines.findIndex(x=>x.startsWith('@'))<0?lines.length:lines.findIndex(x=>x.startsWith('@'))).filter(x=>!/^([\d:.万亿wW+]+|合集)$/.test(x)).join(' '):a.innerText;
 if(title?.trim()){rows.push({platform,title:title.trim().slice(0,300),url:u.href,author:'',time:''});break;}}if(rows.length>=100)break;}
 return {status:'ok',rows,pageUrl};
}
export function installQiyuanBridge(){let active:{id:string;cap:string;abort:AbortController}|undefined;
 const listen=(m:any,s:chrome.runtime.MessageSender,reply:(r:any)=>void)=>{if(s.id!==chrome.runtime.id||s.tab||m?.channel!=='qiyuan-verified')return false;
 if(m.type==='cancel'){if(active?.id===m.taskId&&active?.cap===m.capability)active?.abort.abort();reply({ok:true});return false;}
 if(m.type!=='run'||active||!/^使用浏览器插件/.test(m.text||'')||!/^[-\w]{1,128}$/.test(m.taskId)||!/^[-\w.~]{16,4096}$/.test(m.capability)){reply({ok:false,error:'无效请求或已有任务运行'});return false;}
 const run={id:m.taskId,cap:m.capability,abort:new AbortController()};active=run;reply({ok:true,started:true,taskId:m.taskId});
 const post=async(path:string,data:unknown,signal?:AbortSignal)=>{const res=await fetch('https://ai.qykaiwu.cn/api/browser-plugin/tasks/'+run.id+'/'+path,{method:'POST',credentials:'omit',redirect:'error',headers:{Authorization:'Bearer '+run.cap,'Content-Type':'application/json'},body:JSON.stringify(data),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(10000)});const value=await res.json();if(!res.ok)throw new Error(value.error||'执行机通信失败');return value;};
 void(async()=>{let tab:number|undefined,expected='',seq=0,receipt:any=null;try{tab=(await chrome.tabs.create({url:'about:blank',active:true})).id;if(!tab||tab===m.targetTabId)throw new Error('无法建立独立任务页');
 for(;;){run.abort.signal.throwIfAborted();const a=await post('step',{receipt},run.abort.signal);if(!Number.isSafeInteger(a.seq)||a.seq!==++seq)throw new Error('执行机序号无效');if(a.action==='finish')break;
 try{if(a.action==='navigate'){if(!allowed(a.platform,a.url))throw new Error('目标超出支持范围');expected=a.url;await chrome.tabs.update(tab,{url:expected});}
 else if(['collect','scroll'].includes(a.action)&&allowed(a.platform,expected)){const out=await chrome.scripting.executeScript({target:{tabId:tab},func:readPage,args:[a.platform,expected,a.action==='scroll']});receipt={seq,...out[0].result};if(a.action==='collect')continue;}else throw new Error('不支持的执行机动作');await new Promise(r=>setTimeout(r,1800));if(a.action==='navigate')receipt={seq,status:'ok',rows:[]};}
 catch(e){receipt={seq,status:'error',rows:[],detail:String(e).slice(0,200)};}}
 }catch(e){await post('result',{cancelled:run.abort.signal.aborted,outcome:{error:String(e).slice(0,300)}}).catch(()=>{});}finally{active=undefined;if(tab)await chrome.tabs.remove(tab).catch(()=>{});}})();return false;};chrome.runtime.onMessage.addListener(listen);return ()=>chrome.runtime.onMessage.removeListener(listen);}
