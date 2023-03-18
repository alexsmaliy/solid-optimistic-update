type WayneIconParameters = {
    classes?: string
    icon: string
    [key: string]: any
  }
  
  export default function WayneIcon({ icon, classes, ...props }: WayneIconParameters) {
    return (
      <i class={`material-symbols-rounded ${classes}`} {...props}>
        {icon}
      </i>
    )
  }
  