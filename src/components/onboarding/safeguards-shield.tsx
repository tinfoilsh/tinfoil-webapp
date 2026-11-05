import {
  motion,
  useReducedMotion,
  type Transition,
  type Variants,
} from 'framer-motion'

// The animated shield-check icon in @tinfoilsh/tinfoil-icons, split into the
// shield and its check.
const SHIELD_VIEW_BOX = '-2 -2 24 24'
const SHIELD_PATH =
  'M16.7505-0.00024C16.8885-0.00024 16.9988 0.11222 17.0159 0.24924 17.1303 1.16934 17.8692 1.8959 18.7954 1.98999 18.9102 1.99546 19.0005 2.09013 19.0005 2.20507V10.9324C19.0005 11.1669 18.9349 11.3869 18.8227 11.574L15.8901 16.4607 15.8032 16.5867C15.7091 16.7072 15.5932 16.8102 15.4614 16.8894L10.644 19.78C10.2483 20.0175 9.7527 20.0174 9.3569 19.78L4.53952 16.8894C4.36362 16.7839 4.21636 16.6366 4.11081 16.4607L1.1782 11.574C1.06589 11.3868 0.99949 11.167 0.99949 10.9324V2.24976C0.99949 2.11168 1.11195 2.00139 1.24897 1.98435 2.16898 1.86992 2.8955 1.1309 2.98972 0.20483 2.99574 0.08988 3.09071-0.00024 3.20582-0.00024H16.7505ZM3.00046 10.6522C3.00046 10.6975 3.01278 10.742 3.03609 10.7808L5.6978 15.2167C5.71891 15.2519 5.74836 15.2813 5.78354 15.3024L9.8718 17.7556C9.951 17.8031 10.0499 17.8031 10.1291 17.7556L14.2183 15.3024C14.2535 15.2813 14.283 15.2518 14.3041 15.2166L16.9649 10.7808C16.9882 10.742 17.0005 10.6975 17.0005 10.6522V2.24976C17.0005 2.11169 16.8885 1.99976 16.7505 1.99976H3.25046C3.11239 1.99976 3.00046 2.11168 3.00046 2.24976V10.6522Z'
const CHECK_PATH =
  'M14.8382 6.46591C14.9465 6.55162 14.9647 6.70882 14.879 6.81706L10.2842 12.6211 10.0585 12.9054C10.011 12.9652 9.9389 13 9.8627 13H8.1521C8.0786 13 8.0087 12.9676 7.96123 12.9114L7.73633 12.6455 5.1479 9.5865C5.05868 9.481 5.07187 9.3232 5.17736 9.234L6.32285 8.2658C6.42825 8.1767 6.58592 8.1899 6.67508 8.2952L8.9475 10.9807C8.9579 10.9929 8.9731 11 8.9892 11 9.0059 11 9.0217 10.9924 9.032 10.9793L13.3106 5.57496C13.3963 5.46669 13.5536 5.44842 13.6618 5.53416L14.8382 6.46591Z'

// The icon's check pop: the check gives and springs back while the whole
// shield swells and settles. The icon's motion lasts 2.4s and is still after
// 43.5% of it, so only that part plays here.
const ICON_MOTION_S = 2.4
const SETTLED_AT = 0.435
const POP_S = ICON_MOTION_S * SETTLED_AT
const settledShare = (offset: number) => offset / SETTLED_AT
const RESPONSE_EASE = [0.23, 1, 0.32, 1] as const
const MOVEMENT_EASE = [0.77, 0, 0.175, 1] as const

const SHIELD_POP: Transition = {
  duration: POP_S,
  times: [0, 0.135, 0.195, SETTLED_AT].map(settledShare),
  ease: [RESPONSE_EASE, MOVEMENT_EASE, MOVEMENT_EASE],
}
const CHECK_POP: Transition = {
  duration: POP_S,
  times: [0, 0.06, 0.18, 0.32, SETTLED_AT].map(settledShare),
  ease: [MOVEMENT_EASE, RESPONSE_EASE, MOVEMENT_EASE, MOVEMENT_EASE],
}
const AT_ONCE: Transition = { duration: 0 }

// A shield whose check pops when `popping` turns on, then calls `onPopped`.
export function SafeguardsShield({
  popping,
  onPopped,
  className,
}: {
  popping: boolean
  onPopped: () => void
  className?: string
}) {
  const prefersReducedMotion = useReducedMotion()
  const shield: Variants = {
    rest: { scale: 1 },
    pop: {
      scale: [1, 1.09, 1.09, 1],
      transition: prefersReducedMotion ? AT_ONCE : SHIELD_POP,
    },
  }
  const check: Variants = {
    rest: { scale: 1 },
    pop: {
      scale: [1, 0.9, 1.06, 1, 1],
      transition: prefersReducedMotion ? AT_ONCE : CHECK_POP,
    },
  }

  return (
    <motion.svg
      viewBox={SHIELD_VIEW_BOX}
      fill="currentColor"
      className={className}
      aria-hidden="true"
      variants={shield}
      // A shield that appears already popping still pops, so it still reports
      // when the pop is done.
      initial="rest"
      animate={popping ? 'pop' : 'rest'}
      onAnimationComplete={(definition) => {
        if (definition === 'pop') onPopped()
      }}
    >
      <path d={SHIELD_PATH} />
      <motion.path d={CHECK_PATH} variants={check} />
    </motion.svg>
  )
}
