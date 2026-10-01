import assert from 'node:assert/strict';
import test from 'node:test';
import {companyExposureExcerpts} from '../scripts/company-exposure-excerpts.mjs';
import {supportingExcerptMatches} from '../scripts/daily-workflow-core.mjs';
import {normalizedEvidenceText} from '../scripts/daily-source-audit.mjs';

test('printed line wraps preserve the complete financing subject, factor and intervening page footer', () => {
  const text='Our business depends on the availability of financing.\nCapital and credit markets can experience volatility and disruptions that reduce\nliquidity and increase borrowing costs.\nFactors beyond our control, including economic conditions and increases in benchmark interest rates,\n2025 FORM 10-K 14\ncould increase our cost of financing.\nHowever, we hedge part of this exposure and cannot attribute all financial changes to interest rates.';
  const quotes=companyExposureExcerpts(text);
  assert.ok(quotes.some(q=>q.includes('Factors beyond our control')&&q.includes('2025 FORM 10-K 14')&&q.includes('However, we hedge')));
  assert.ok(quotes.every(q=>supportingExcerptMatches(normalizedEvidenceText(text),normalizedEvidenceText(q),q)));
  assert.ok(!quotes.some(q=>q.startsWith('liquidity')||q.startsWith('could increase')));
});

test('the excerpt allowance cannot chop away a trailing denial or promote a lowercase tail fragment', () => {
  const long=`Our financing and interest rates may affect our financial results. However, we ${'maintain liquidity and hedge these exposures '.repeat(20)}and have no financial statement sensitivity.`;
  assert.deepEqual(companyExposureExcerpts(long),[]);
  assert.deepEqual(companyExposureExcerpts('alternative funding, adversely affecting our business and financing.'),[]);
});

test('rate-sensitivity denials remain visible while lease and stock-option accounting assumptions do not displace business risk', () => {
  const text='The Company uses a Black-Scholes model to estimate the fair value of stock options using the risk-free interest rate.\nOur borrowing costs increase with higher interest rates. However, we hedge part of this exposure.\nWe carry fixed-rate debt and have no financial statement risk from changes in interest rates.';
  const quotes=companyExposureExcerpts(text);
  assert.ok(quotes.some(q=>q.includes('no financial statement risk')));
  assert.ok(quotes.every(q=>supportingExcerptMatches(normalizedEvidenceText(text),normalizedEvidenceText(q),q)));
  const accounting='The Company determines a lease at its commencement date. Lease assets represent our right to use an underlying asset and use an incremental borrowing rate.';
  assert.deepEqual(companyExposureExcerpts(accounting),[]);
  assert.deepEqual(companyExposureExcerpts('The Company uses a Black-Scholes model to value stock options using a risk-free interest rate.'),[]);
  assert.deepEqual(companyExposureExcerpts('The Company uses a Monte Carlo simulation to estimate the fair value of PSUs. The assumptions for valuing these PSUs include the risk-free interest rate.'),[]);
});

test('explicit rate exposures and their denials cannot be crowded out by earlier generic financing mentions', () => {
  const generic=['Our financing discussions affect emerging market deal closures.', 'Our credit market activity includes various routine financial arrangements.', 'Our financing transactions affect the presentation of the cash flow statement.'].join(' Unrelated discussion ends here. ');
  const text=generic+' Separate background ends here. Increases in benchmark interest rates could increase our cost of financing. However, we hedge this exposure and historical fluctuations have not been significant for us.';
  const quotes=companyExposureExcerpts(text);
  assert.ok(quotes.some(q=>q.includes('Increases in benchmark interest rates')&&q.includes('not been significant')));
  assert.ok(quotes.every(q=>supportingExcerptMatches(normalizedEvidenceText(text),normalizedEvidenceText(q),q)));
});

test('same-topic intervening sentences cannot separate rate exposure from its historical qualification', () => {
  const text='We are exposed to market risk from changes in interest rates. We are subject to interest rate risks in our business. The level of our interest rate risk depends on our debt exposure and capital structure. Historical fluctuations in interest rates have not been significant for us; however, our capital structure may change.';
  const quotes=companyExposureExcerpts(text);
  assert.ok(quotes.some(q=>q.includes('We are exposed')&&q.includes('have not been significant')));
  assert.ok(quotes.every(q=>supportingExcerptMatches(normalizedEvidenceText(text),normalizedEvidenceText(q),q)));
});

test('later explicit sensitivity denials and expense decreases remain available as contrary evidence', () => {
  const text=['Interest rates may affect our financing arrangements.', 'Our interest rate risk depends on our ordinary activities.', 'Interest rate changes can affect our general business conditions.', 'Our fixed-rate debt has no financial statement risk from interest rates.', 'At year end, a 100 basis point increase in short-term interest rates would have decreased the Company’s net interest expense by $8 million.'].join(' A separate section follows. ');
  const quotes=companyExposureExcerpts(text);
  assert.ok(quotes.some(q=>q.includes('no financial statement risk')));
  assert.ok(quotes.some(q=>q.includes('decreased')&&q.includes('$8 million')));
});
