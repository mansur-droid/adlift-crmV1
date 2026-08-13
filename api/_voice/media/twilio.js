function muLawSample(u){u=(~u)&0xff;const sign=u&0x80;const exponent=(u>>4)&0x07;const mantissa=u&0x0f;let sample=((mantissa<<3)+0x84)<<exponent;sample-=0x84;return sign?-sample:sample}
export function mulawRms(buffer){if(!buffer?.length)return 0;let sum=0;for(const b of buffer){const s=muLawSample(b)/32768;sum+=s*s}return Math.sqrt(sum/buffer.length)}

export function createTwilioMediaTransport({socket,now=()=>Date.now(),bargeInRms=0.035,bargeInFrames=3}={}){
 let streamSid=null;let callSid=null;let lastInboundSequence=0;let speechFrames=0;let outboundSeq=0;let closed=false;const pendingMarks=new Map();
 const send=obj=>{if(closed||!socket||socket.readyState!==1)return false;socket.send(JSON.stringify(obj));return true};
 return {
  slug:'twilio-media',kind:'telephony_media',
  start(evt){streamSid=String(evt.streamSid||evt.start?.streamSid||'');callSid=String(evt.start?.callSid||'');return {streamSid,callSid,customParameters:evt.start?.customParameters||{},mediaFormat:evt.start?.mediaFormat||{}}},
  ingest(evt){const sequence=Number(evt.sequenceNumber||0);if(sequence&&sequence<=lastInboundSequence)return {duplicate:true};if(sequence)lastInboundSequence=sequence;if(evt.event!=='media'||!evt.media?.payload)return {ignored:true};const audio=Buffer.from(evt.media.payload,'base64');const rms=mulawRms(audio);speechFrames=rms>=bargeInRms?speechFrames+1:0;return {audio,rms,speechDetected:speechFrames>=bargeInFrames,timestampMs:Number(evt.media.timestamp||0),sequence}},
  sendAudio(buffer,turnId){if(!streamSid||!buffer?.length)return false;outboundSeq+=1;return send({event:'media',streamSid,media:{payload:Buffer.from(buffer).toString('base64')}})},
  mark(turnId){if(!streamSid)return null;const name=`turn:${turnId}:${++outboundSeq}`;pendingMarks.set(name,{turnId,sentAt:now()});send({event:'mark',streamSid,mark:{name}});return name},
  acknowledgeMark(evt){const name=evt.mark?.name;const mark=name?pendingMarks.get(name):null;if(name)pendingMarks.delete(name);return mark?{...mark,name,playedAt:now()}:null},
  clear(){if(!streamSid)return false;pendingMarks.clear();speechFrames=0;return send({event:'clear',streamSid})},
  close(){closed=true;pendingMarks.clear()},
  get state(){return {streamSid,callSid,lastInboundSequence,pendingMarks:pendingMarks.size}}
 };
}
