import LegalLayout from './LegalLayout'

export default function Terms() {
  return (
    <LegalLayout
      title="Terms of Service"
      lastUpdated="8 September 2026"
      otherDocHref="/privacy"
      otherDocLabel="Privacy Policy"
    >
      <div className="text-sm text-ink-700 leading-relaxed space-y-6">
        <p className="text-xs text-ink-500 italic">
          This page is a plain-language summary of the terms for using SnackLabs. It is not legal advice.
        </p>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">What SnackLabs is</h2>
          <p>
            SnackLabs is an internal office pantry ordering tool provided by [LEGAL ENTITY] for staff use, as-is and
            without any guarantee of uptime, accuracy or fitness for any particular purpose.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">Payment happens outside the app</h2>
          <p>
            SnackLabs does not process or hold payments and is not a payment processor. You pay for your order
            separately, outside the app — by e-wallet, bank transfer or cash — using the payment details shown at
            checkout. Inside the app you only record a claim that payment was made, by uploading a screenshot or cash
            photo. That claim is then checked, either automatically or by an administrator, before your order is
            confirmed as paid.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">Stock and prices can change</h2>
          <p>
            Prices and available stock shown in the app can change at any time and are not locked in until an order
            is placed. Placing an order is not a guarantee that it will be fulfilled — an item may turn out to be
            unavailable, or an order may be cancelled, before it is confirmed.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">Administrator authority</h2>
          <p>
            Administrators may cancel, void or delete an order, and may revoke any person&apos;s access to SnackLabs
            at their discretion, for example to resolve a payment dispute, correct an error, or address misuse.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">No warranty</h2>
          <p>
            SnackLabs is provided without warranty of any kind. To the extent permitted by law, [LEGAL ENTITY] is not
            liable for losses arising from use of the tool, including payment mistakes made outside the app, stock
            shortages, or service interruptions.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">Questions</h2>
          <p>
            For questions about these terms, contact <span className="font-semibold">[CONTACT EMAIL]</span>.
          </p>
        </section>
      </div>
    </LegalLayout>
  )
}
