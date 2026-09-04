interface CameraAiMarkProps {
  className?: string
  strokeWidth?: number
}

export default function CameraAiMark({ className, strokeWidth = 2 }: CameraAiMarkProps) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <g transform="translate(-0.1 2.3) scale(0.78)" strokeWidth={strokeWidth / 0.78}>
        <path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" />
        <circle cx={12} cy={13} r={3} />
      </g>
      <path d="M19.3 2L19.97 3.93L21.9 4.6L19.97 5.27L19.3 7.2L18.63 5.27L16.7 4.6L18.63 3.93Z" />
    </svg>
  )
}
