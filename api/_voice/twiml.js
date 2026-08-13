export function buildVoiceMediaResponse(twilioLib,{url,attemptId,mediaToken}){
 const response=new twilioLib.twiml.VoiceResponse();
 const connect=response.connect();
 const stream=connect.stream({url});
 stream.parameter({name:'attemptId',value:attemptId});
 stream.parameter({name:'mediaToken',value:mediaToken});
 response.hangup();
 return response.toString();
}
