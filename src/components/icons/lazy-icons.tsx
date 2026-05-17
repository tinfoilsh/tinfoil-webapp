import { lazy, Suspense } from 'react'
import type { IconBaseProps } from 'react-icons'

const AiOutlineCloudSyncLazy = lazy(() =>
  import('react-icons/ai').then((m) => ({ default: m.AiOutlineCloudSync })),
)
const AiOutlineLoading3QuartersLazy = lazy(() =>
  import('react-icons/ai').then((m) => ({
    default: m.AiOutlineLoading3Quarters,
  })),
)
const FaLockLazy = lazy(() =>
  import('react-icons/fa').then((m) => ({ default: m.FaLock })),
)
const FaKeyLazy = lazy(() =>
  import('react-icons/fa').then((m) => ({ default: m.FaKey })),
)
const MdOutlineCloudOffLazy = lazy(() =>
  import('react-icons/md').then((m) => ({ default: m.MdOutlineCloudOff })),
)
const FiArrowUpLazy = lazy(() =>
  import('react-icons/fi').then((m) => ({ default: m.FiArrowUp })),
)
const PiSpinnerThinLazy = lazy(() =>
  import('react-icons/pi').then((m) => ({ default: m.PiSpinnerThin })),
)

const FaFileLazy = lazy(() =>
  import('react-icons/fa').then((m) => ({ default: m.FaFile })),
)
const FaFilePdfLazy = lazy(() =>
  import('react-icons/fa').then((m) => ({ default: m.FaFilePdf })),
)
const FaFileWordLazy = lazy(() =>
  import('react-icons/fa').then((m) => ({ default: m.FaFileWord })),
)
const FaFileExcelLazy = lazy(() =>
  import('react-icons/fa').then((m) => ({ default: m.FaFileExcel })),
)
const FaFilePowerpointLazy = lazy(() =>
  import('react-icons/fa').then((m) => ({ default: m.FaFilePowerpoint })),
)
const FaFileCodeLazy = lazy(() =>
  import('react-icons/fa').then((m) => ({ default: m.FaFileCode })),
)
const FaFileImageLazy = lazy(() =>
  import('react-icons/fa').then((m) => ({ default: m.FaFileImage })),
)
const FaFileVideoLazy = lazy(() =>
  import('react-icons/fa').then((m) => ({ default: m.FaFileVideo })),
)
const FaFileAudioLazy = lazy(() =>
  import('react-icons/fa').then((m) => ({ default: m.FaFileAudio })),
)
const FaFileArchiveLazy = lazy(() =>
  import('react-icons/fa').then((m) => ({ default: m.FaFileArchive })),
)
const FaFileAltLazy = lazy(() =>
  import('react-icons/fa').then((m) => ({ default: m.FaFileAlt })),
)

function IconWrapper({ Icon, ...props }: { Icon: any } & IconBaseProps) {
  return (
    <Suspense
      fallback={
        <span
          style={{ display: 'inline-block', width: '1em', height: '1em' }}
        />
      }
    >
      <Icon {...props} />
    </Suspense>
  )
}

export const AiOutlineCloudSync = (props: IconBaseProps) => (
  <IconWrapper Icon={AiOutlineCloudSyncLazy} {...props} />
)
export const AiOutlineLoading3Quarters = (props: IconBaseProps) => (
  <IconWrapper Icon={AiOutlineLoading3QuartersLazy} {...props} />
)
export const FaLock = (props: IconBaseProps) => (
  <IconWrapper Icon={FaLockLazy} {...props} />
)
export const FaKey = (props: IconBaseProps) => (
  <IconWrapper Icon={FaKeyLazy} {...props} />
)
export const MdOutlineCloudOff = (props: IconBaseProps) => (
  <IconWrapper Icon={MdOutlineCloudOffLazy} {...props} />
)
export const FiArrowUp = (props: IconBaseProps) => (
  <IconWrapper Icon={FiArrowUpLazy} {...props} />
)
export const PiSpinnerThin = (props: IconBaseProps) => (
  <IconWrapper Icon={PiSpinnerThinLazy} {...props} />
)
export const FaFile = (props: IconBaseProps) => (
  <IconWrapper Icon={FaFileLazy} {...props} />
)
export const FaFilePdf = (props: IconBaseProps) => (
  <IconWrapper Icon={FaFilePdfLazy} {...props} />
)
export const FaFileWord = (props: IconBaseProps) => (
  <IconWrapper Icon={FaFileWordLazy} {...props} />
)
export const FaFileExcel = (props: IconBaseProps) => (
  <IconWrapper Icon={FaFileExcelLazy} {...props} />
)
export const FaFilePowerpoint = (props: IconBaseProps) => (
  <IconWrapper Icon={FaFilePowerpointLazy} {...props} />
)
export const FaFileCode = (props: IconBaseProps) => (
  <IconWrapper Icon={FaFileCodeLazy} {...props} />
)
export const FaFileImage = (props: IconBaseProps) => (
  <IconWrapper Icon={FaFileImageLazy} {...props} />
)
export const FaFileVideo = (props: IconBaseProps) => (
  <IconWrapper Icon={FaFileVideoLazy} {...props} />
)
export const FaFileAudio = (props: IconBaseProps) => (
  <IconWrapper Icon={FaFileAudioLazy} {...props} />
)
export const FaFileArchive = (props: IconBaseProps) => (
  <IconWrapper Icon={FaFileArchiveLazy} {...props} />
)
export const FaFileAlt = (props: IconBaseProps) => (
  <IconWrapper Icon={FaFileAltLazy} {...props} />
)
