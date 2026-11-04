// Edit this file to configure selling. See README "Getting paid".
export const CONFIG = {
  appName: 'FrameCraft',
  priceMonthly: 'A$9',
  priceYearly: 'A$79',
  // Stripe Payment Links (dashboard.stripe.com → Payment Links). Leave '' until created.
  stripeMonthlyLink: '',
  stripeYearlyLink: '',
  supportEmail: '',
  // Public half of the signing key from `node tools/license.mjs init`.
  publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'Pw3_rUCGMbvbzoLjHgreTHZp8BAr06CC5kKSUdxOc6E', y: '542xIMbb_2Jffu1DF8dr-eArVLsdMAWFOklyLJwRvLg' },
  free: {
    photoMaxExport: 1920, // longest side, px
    photoMaxLayers: 5,
    videoMaxHeight: 720,
    videoMaxSeconds: 60,
    videoMaxTracks: 3,
  },
};
