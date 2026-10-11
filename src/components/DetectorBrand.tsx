export function DetectorBrand() {
  return (
    <a className="account-brand" href="/" aria-label="格物检测首页">
      <svg width="36" height="36" viewBox="0 0 40 40" aria-hidden="true">
        <rect width="40" height="40" rx="11" fill="#2f6d50" />
        <g fill="#ecf4e9">
          <rect x="9" y="9" width="9" height="9" rx="2" />
          <rect x="22" y="9" width="9" height="9" rx="2" opacity=".65" />
          <rect x="9" y="22" width="9" height="9" rx="2" opacity=".65" />
        </g>
        <path
          d="m22 26 3 3 6-7"
          fill="none"
          stroke="#ecf4e9"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        格物<small>有据可验</small>
      </span>
    </a>
  )
}
