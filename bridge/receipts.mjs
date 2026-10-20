// Keep only diagnostic fields. Neither an API acceptance nor a message ID is
// a client delivery/read receipt. Never retain raw responses or credentials.
const code = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
};
function messageId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (!['number', 'string', 'bigint'].includes(typeof value)) return null;
  const text = String(value);
  return /^\d{1,80}$/.test(text) && BigInt(text) > 0n ? text : null;
}
export function sanitizeReceipt(value) {
  if (!value || !/^[\w:.-]{1,200}$/.test(value.clientId || '') ||
    !Number.isSafeInteger(value.acceptedAt) || value.acceptedAt <= 0) return null;
  const serverMessageId = messageId(value.serverMessageId);
  return { clientId: value.clientId, acceptedAt: value.acceptedAt,
    ret: code(value.ret), errcode: code(value.errcode), serverMessageId,
    serverMessageIdStatus: serverMessageId ? 'returned' : value.serverMessageIdStatus === 'invalid' ? 'invalid' : 'missing' };
}
export function receiptFromResponse(response, clientId, acceptedAt = Date.now()) {
  const value = response?.message_id;
  const missing = value === undefined || value === null || value === '';
  return sanitizeReceipt({ clientId, acceptedAt, ret: response?.ret, errcode: response?.errcode,
    serverMessageId: value, serverMessageIdStatus: missing ? 'missing' : 'invalid' });
}
