import {
  BsFile,
  BsFiletypeCss,
  BsFiletypeCsv,
  BsFiletypeDoc,
  BsFiletypeDocx,
  BsFiletypeGif,
  BsFiletypeHtml,
  BsFiletypeJpg,
  BsFiletypeJs,
  BsFiletypeJson,
  BsFiletypeJsx,
  BsFiletypeMd,
  BsFiletypeMov,
  BsFiletypeMp3,
  BsFiletypeMp4,
  BsFiletypePdf,
  BsFiletypePng,
  BsFiletypePpt,
  BsFiletypePptx,
  BsFiletypeTsx,
  BsFiletypeTxt,
  BsFiletypeWav,
  BsFiletypeXls,
  BsFiletypeXlsx,
  BsFiletypeXml,
} from 'react-icons/bs'

type MacFileIconProps = {
  filename: string
  size?: number
}

export function MacFileIcon({ filename, size = 20 }: MacFileIconProps) {
  const extension = filename.toLowerCase().split('.').pop() || ''
  const iconClass = 'text-content-secondary'

  const getIcon = () => {
    switch (extension) {
      case 'pdf':
        return <BsFiletypePdf size={size} className={iconClass} />
      case 'doc':
        return <BsFiletypeDoc size={size} className={iconClass} />
      case 'docx':
        return <BsFiletypeDocx size={size} className={iconClass} />
      case 'xls':
        return <BsFiletypeXls size={size} className={iconClass} />
      case 'xlsx':
        return <BsFiletypeXlsx size={size} className={iconClass} />
      case 'csv':
        return <BsFiletypeCsv size={size} className={iconClass} />
      case 'ppt':
        return <BsFiletypePpt size={size} className={iconClass} />
      case 'pptx':
        return <BsFiletypePptx size={size} className={iconClass} />
      case 'html':
      case 'htm':
        return <BsFiletypeHtml size={size} className={iconClass} />
      case 'css':
        return <BsFiletypeCss size={size} className={iconClass} />
      case 'js':
        return <BsFiletypeJs size={size} className={iconClass} />
      case 'jsx':
        return <BsFiletypeJsx size={size} className={iconClass} />
      case 'ts':
      case 'tsx':
        return <BsFiletypeTsx size={size} className={iconClass} />
      case 'json':
        return <BsFiletypeJson size={size} className={iconClass} />
      case 'md':
        return <BsFiletypeMd size={size} className={iconClass} />
      case 'xml':
        return <BsFiletypeXml size={size} className={iconClass} />
      case 'txt':
        return <BsFiletypeTxt size={size} className={iconClass} />
      case 'png':
        return <BsFiletypePng size={size} className={iconClass} />
      case 'jpg':
      case 'jpeg':
        return <BsFiletypeJpg size={size} className={iconClass} />
      case 'gif':
        return <BsFiletypeGif size={size} className={iconClass} />
      case 'mp3':
        return <BsFiletypeMp3 size={size} className={iconClass} />
      case 'wav':
        return <BsFiletypeWav size={size} className={iconClass} />
      case 'mp4':
        return <BsFiletypeMp4 size={size} className={iconClass} />
      case 'mov':
        return <BsFiletypeMov size={size} className={iconClass} />
      default:
        return <BsFile size={size} className={iconClass} />
    }
  }

  return getIcon()
}
