const DEFAULT_TEMPLATE =
  'Hi {name}, you completed your shift on time. You are eligible for payment of {amount} {currency}. Date: {date}.';

function formatAmount(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return '0';
  return Number.isInteger(x) ? String(x) : x.toFixed(2);
}

/**
 * @param {string} template - with {name}, {amount}, {date}, {currency}
 * @param {{ name: string, amount: number|string, date: string, currency?: string }} vars
 */
function renderEligibilitySms(template, vars) {
  const t = (template && String(template).trim()) || DEFAULT_TEMPLATE;
  const currency = vars.currency != null && String(vars.currency).trim() !== '' ? String(vars.currency).trim() : 'TZS';
  const name = vars.name != null ? String(vars.name) : '';
  const date = vars.date != null ? String(vars.date) : '';
  const amount = formatAmount(vars.amount);
  return t
    .replace(/\{name\}/g, name)
    .replace(/\{amount\}/g, amount)
    .replace(/\{date\}/g, date)
    .replace(/\{currency\}/g, currency);
}

module.exports = {
  DEFAULT_TEMPLATE,
  renderEligibilitySms,
};
