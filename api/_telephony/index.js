import {createTwilioProvider} from './twilio.js';
export function getTelephonyProvider(slug='twilio'){if(slug!=='twilio')throw new Error(`Unsupported telephony provider: ${slug}`);return createTwilioProvider();}
export const telephonyInterface=['createCall','cancelCall','fetchCall','fetchCallCost','validateWebhook','parseProviderEvent','normalizeProviderStatus','reconcileCall'];
