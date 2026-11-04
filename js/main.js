// App shell: mode tabs, plan status and the upgrade / license dialog.
import { CONFIG } from './config.js';
import { License } from './license.js';
import { el, modal, toast } from './ui.js';

const roots = { photo: document.getElementById('photo-root'), video: document.getElementById('video-root') };
const mounted = {};

async function show(mode) {
  for (const [m, root] of Object.entries(roots)) root.classList.toggle('hidden', m !== mode);
  document.querySelectorAll('#mode-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  if (!mounted[mode]) {
    mounted[mode] = true;
    const mod = await import(`./${mode}/${mode}.js`);
    mod.mount(roots[mode]);
  }
  window.dispatchEvent(new CustomEvent('fc:mode', { detail: { mode } }));
  history.replaceState(null, '', `#${mode}`);
}

document.getElementById('mode-tabs').addEventListener('click', (e) => {
  const mode = e.target.closest('button')?.dataset.mode;
  if (mode) show(mode);
});

function renderStatus() {
  const info = License.info();
  const status = document.getElementById('plan-status');
  const btn = document.getElementById('upgrade-btn');
  if (info) {
    status.innerHTML = '';
    status.append(el('span', { class: 'pro-badge' }, 'PRO'), info.expires ? ` until ${new Date(info.expires).toLocaleDateString()}` : ' lifetime');
    btn.textContent = 'License';
    btn.classList.remove('primary');
  } else {
    status.textContent = 'Free plan';
    btn.textContent = 'Upgrade to Pro';
    btn.classList.add('primary');
  }
}

function buyButton(label, link) {
  return link
    ? el('a', { class: 'btn primary', href: link, target: '_blank', rel: 'noopener' }, label)
    : el('button', { class: 'btn', disabled: true, title: 'Payments are not set up yet (see README)' }, label);
}

function openUpgrade(feature) {
  const info = License.info();
  const keyInput = el('textarea', { rows: 3, placeholder: 'Paste your license key (FC1.…)', style: { width: '100%', resize: 'vertical' } });
  const activate = async () => {
    const r = await License.activate(keyInput.value);
    if (r.ok) { toast('Pro unlocked. Thank you! 🎉', 'ok'); dlg.close(); } else toast(r.error, 'err', 4000);
  };
  const body = el('div', { class: 'modal-body' },
    feature && !info ? el('p', { style: { margin: 0 } }, el('b', {}, feature), ' is a Pro feature.') : null,
    info
      ? el('div', { class: 'panel', style: { padding: '12px' } },
          el('div', {}, el('span', { class: 'pro-badge' }, 'PRO'), ' active for ', el('b', {}, info.email)),
          el('div', { class: 'muted' }, info.expires ? `Renews / expires ${new Date(info.expires).toLocaleString()}` : 'Lifetime license'),
          el('div', { class: 'row', style: { marginTop: '10px' } },
            el('button', { class: 'btn danger', onclick: () => { License.deactivate(); dlg.close(); toast('License removed from this browser'); } }, 'Remove license')))
      : el('div', { class: 'plans' },
          el('div', { class: 'plan' },
            el('b', {}, 'Monthly'), el('div', { class: 'price' }, CONFIG.priceMonthly, el('small', { class: 'muted' }, ' /mo')),
            el('ul', {}, el('li', {}, 'No watermark'), el('li', {}, 'Full-resolution & 4K export'), el('li', {}, 'Unlimited layers & tracks'), el('li', {}, 'All Pro tools & filters'), el('li', {}, 'Save / open projects')),
            buyButton('Get monthly', CONFIG.stripeMonthlyLink)),
          el('div', { class: 'plan best' },
            el('b', {}, 'Yearly ', el('span', { class: 'pro-badge' }, 'SAVE 27%')), el('div', { class: 'price' }, CONFIG.priceYearly, el('small', { class: 'muted' }, ' /yr')),
            el('ul', {}, el('li', {}, 'Everything in monthly'), el('li', {}, 'Two-plus months free')),
            buyButton('Get yearly', CONFIG.stripeYearlyLink))),
    info ? null : el('p', { class: 'muted', style: { margin: 0 } }, 'After paying you get a license key by email. Paste it below. Everything runs in your browser, and your files never leave your computer.'),
    info ? null : keyInput,
    info ? null : el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: activate }, 'Activate key'),
      CONFIG.supportEmail ? el('a', { class: 'muted', href: `mailto:${CONFIG.supportEmail}` }, 'Need help?') : null));
  const dlg = modal(info ? 'Your license' : 'FrameCraft Pro', body);
}

document.getElementById('upgrade-btn').addEventListener('click', () => openUpgrade());
window.addEventListener('fc:upgrade', (e) => openUpgrade(e.detail?.feature));
License.onChange(renderStatus);

await License.init();
show(location.hash === '#video' ? 'video' : 'photo');
