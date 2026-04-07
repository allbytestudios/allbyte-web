<script>
  let { label = "Join the Studio", priceId = "" } = $props();

  function handleClick() {
    // TODO: Implement Stripe Checkout redirect
    // const stripe = await loadStripe(STRIPE_PUBLIC_KEY);
    // await stripe.redirectToCheckout({ lineItems: [{ price: priceId, quantity: 1 }], mode: 'subscription' });
    // TODO: Implement Stripe Checkout redirect
  }
</script>

<button class="stripe-btn" onclick={handleClick}>
  {label}
</button>

<style>
  .stripe-btn {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    background: rgba(255, 255, 255, 0.95);
    color: #1a1a1a;
    border: 1px solid rgba(255, 255, 255, 0.3);
    padding: 0.75rem 2rem;
    font-size: 1rem;
    cursor: pointer;
    letter-spacing: 0.04em;
    transition: all 0.25s;
    border-radius: 2px;
    backdrop-filter: blur(8px);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  }

  .stripe-btn:hover {
    background: #fff;
    transform: translateY(-2px);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  }

  .stripe-btn:active {
    transform: translateY(0);
  }
</style>
