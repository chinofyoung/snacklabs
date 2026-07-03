const fmt = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 2,
})

export function formatPeso(amount: number): string {
  return fmt.format(amount)
}
