// Paste this into Google Forms -> Extensions -> Apps Script.
// Then create an installable trigger: onFormSubmit -> From form -> On form submit.

const CRM_WEBHOOK_URL = 'https://adlift-crm-v1-git-main-mansur-s-projects3.vercel.app/api/form-submit';
const CRM_WEBHOOK_SECRET = 'CHANGE_ME_TO_THE_SAME_SECRET_AS_VERCEL';

function onFormSubmit(e) {
  const payload = {};

  if (e && e.namedValues) {
    Object.keys(e.namedValues).forEach(function (key) {
      payload[key] = Array.isArray(e.namedValues[key]) ? e.namedValues[key][0] : e.namedValues[key];
    });
  }

  UrlFetchApp.fetch(CRM_WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-adlift-form-secret': CRM_WEBHOOK_SECRET
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}
