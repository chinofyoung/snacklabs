import LegalLayout from './LegalLayout'

export default function Privacy() {
  return (
    <LegalLayout
      title="Privacy Policy"
      lastUpdated="2 October 2026"
      otherDocHref="/terms"
      otherDocLabel="Terms of Service"
    >
      <div className="text-sm text-ink-700 leading-relaxed space-y-6">
        <p className="text-xs text-ink-500 italic">
          This page is a plain-language summary of how SnackLabs handles data for the people who use it. It is not
          legal advice.
        </p>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">Signing in</h2>
          <p>
            SnackLabs is a tool for ordering snacks from the office pantry. You can sign in with your Google account,
            or register with your name, email address and a password. We store your email address and name, plus your
            avatar (profile photo) URL if you use Google, in a profile record tied to your account. We do not receive
            or store your Google password. A password you choose for SnackLabs is stored only in hashed form by
            Supabase, our authentication provider.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">Who can use SnackLabs</h2>
          <p>
            You can sign in with Google or with an email address and password, but only people whose email address is
            at a domain an administrator has approved can register. A new account cannot be used until an
            administrator confirms it. An administrator can also revoke a person&apos;s access at any time, which
            blocks further sign-ins without deleting that person&apos;s existing order history.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">Orders and payments</h2>
          <p>
            When you place an order, we store the items, quantities and prices as an order record linked to your
            account. When you pay, you upload a screenshot (or, for cash, a photo of the cash) as proof of payment.
            That image is stored in private cloud storage that only you and administrators can read — it is never
            made public.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">Automated review by Anthropic&apos;s Claude API</h2>
          <p>
            To confirm a payment quickly, the receipt or cash photo you upload is sent to Anthropic&apos;s Claude API,
            which reads the image and reports back whether the amount and recipient look correct (or, for a cash
            photo, an estimated total). Anthropic processes the image to produce that verdict; if the result is
            unclear, an administrator reviews the payment manually instead.
          </p>
          <p>
            Separately, when an administrator photographs the pantry shelves to check or update stock, that shelf
            photo — along with the current product catalog (names and prices, no customer data) — is also sent to
            Anthropic&apos;s Claude API, which identifies the products and quantities visible in the photo. This
            feature is only available to administrators; it does not involve your personal data unless you appear
            incidentally in a shelf photo.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">Your shopping cart</h2>
          <p>
            Items you add to your cart before checking out are kept only in your browser&apos;s local storage on your
            own device. Your cart is never sent to or stored on our servers until you actually place an order.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">Where data is stored</h2>
          <p>
            Profiles, orders and related records are stored in a Postgres database, and receipt and shelf images are
            stored in object storage, both hosted by Supabase.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">Who can see your data</h2>
          <p>
            Your profile information (name, email, avatar) is visible only to you and to administrators; other users
            cannot see it. Your orders, order contents and payment receipts are likewise visible only to you and to
            administrators. Administrators can see every order, every uploaded receipt, and every user account in
            order to run the pantry and resolve payment issues.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="font-display text-lg font-bold text-ink-900">Deletion requests and questions</h2>
          <p>
            To ask a question about this policy or to request that your data be deleted, contact{' '}
            <span className="font-semibold">[CONTACT EMAIL]</span>. Because order records may also serve as our
            record of a completed purchase, we may need to retain a minimal record of past orders even after a
            deletion request.
          </p>
        </section>
      </div>
    </LegalLayout>
  )
}
