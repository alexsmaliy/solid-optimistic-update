type IconParams = {
  classes?: string
  icon: string
  [key: string]: any
}

export default function WayneIcon({ icon, classes, ...props }: IconParams) {
  return (
    <i class={`material-symbols-rounded ${classes}`} {...props}>
      {icon}
    </i>
  )
}
