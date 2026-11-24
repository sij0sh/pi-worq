import {createWorq} from '../../index.ts';
import {Telemetry} from '../../src/telemetry.ts';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
export default function fixture(pi: ExtensionAPI) {
  const t=new Telemetry(); createWorq({telemetry:t})(pi);
  pi.on('session_start',async()=>{
    t.add('a','aaaa','plan'); t.add('b','bbbb','execute'); t.add('q','bbbb','PQ d1','b',undefined,'Can recovery resume?');
    for(const [key,r] of t.rows){ r.born-=7200000; t.state(key,'running'); const sink=t.sink(key); sink({setup:{skills:['review']}}); sink({phase:'request'}); }
    for(let i=0;i<300;i++){const sink=t.sink(i%2?'a':'q'); sink({turn:true}); sink({start:'1',name:'read_file'}); sink({end:'1',outcome:{kind:'ok'}});}
    t.activity.forEach((e,i) => { e.at -= (t.activity.length-i)*240; });
    t.sink('q')({cache:{read:940,write:0,input:60,speed:72}}); t.sink('q')({start:'2',name:'read_file'});
  });
}
