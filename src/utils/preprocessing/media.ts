/**
 * Media preprocessing utilities for document upload
 */

interface ImageScaleOptions {
  maxWidth?: number
  maxHeight?: number
  quality?: number
}

/**
 * Scales down an image to fit within specified dimensions while maintaining aspect ratio
 * @param file - The image file to scale
 * @param options - Scaling options (maxWidth, maxHeight, quality)
 * @returns A promise that resolves to a scaled image blob
 */
export async function scaleImage(
  file: File,
  options: ImageScaleOptions = {},
): Promise<Blob> {
  const { maxWidth = 1920, maxHeight = 1080, quality = 0.9 } = options

  return new Promise((resolve, reject) => {
    const img = new Image()
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')

    if (!ctx) {
      reject(new Error('Failed to get canvas context'))
      return
    }

    img.onload = () => {
      // Calculate new dimensions
      let width = img.width
      let height = img.height

      if (width > maxWidth || height > maxHeight) {
        const widthRatio = maxWidth / width
        const heightRatio = maxHeight / height
        const ratio = Math.min(widthRatio, heightRatio)

        width = Math.floor(width * ratio)
        height = Math.floor(height * ratio)
      }

      // Set canvas dimensions
      canvas.width = width
      canvas.height = height

      // Draw scaled image
      ctx.drawImage(img, 0, 0, width, height)

      // Convert to blob
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob)
          } else {
            reject(new Error('Failed to convert canvas to blob'))
          }
        },
        file.type,
        quality,
      )
    }

    img.onerror = () => {
      reject(new Error('Failed to load image'))
    }

    // Read the image file
    const reader = new FileReader()
    reader.onload = (e) => {
      if (e.target?.result) {
        img.src = e.target.result as string
      }
    }
    reader.onerror = () => {
      reject(new Error('Failed to read image file'))
    }
    reader.readAsDataURL(file)
  })
}

/**
 * Checks if a file is an image based on its MIME type
 * @param file - The file to check
 * @returns true if the file is an image, false otherwise
 */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

/**
 * Checks if a file is an audio file based on its MIME type
 * @param file - The file to check
 * @returns true if the file is an audio file, false otherwise
 */
export function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/')
}

/**
 * Converts a blob to base64 string
 * @param blob - The blob to convert
 * @returns A promise that resolves to the base64 string (without data URL prefix)
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const reader = new FileReader()

  return new Promise<string>((resolve, reject) => {
    reader.onload = (e) => {
      if (e.target?.result) {
        const base64String = e.target.result as string
        // Remove the data URL prefix to get just the base64 data
        const base64Data = base64String.split(',')[1]
        resolve(base64Data)
      } else {
        reject(new Error('Failed to convert blob to base64'))
      }
    }
    reader.onerror = () => reject(new Error('Error reading blob'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Scales an image and converts it to base64
 * @param file - The image file to process
 * @param options - Scaling options
 * @returns A promise that resolves to an object with base64 data and mime type
 */
export async function scaleAndEncodeImage(
  file: File,
  options: ImageScaleOptions = {},
): Promise<{ base64: string; mimeType: string }> {
  const scaledBlob = await scaleImage(file, options)
  const base64 = await blobToBase64(scaledBlob)
  const mimeType = scaledBlob.type || file.type

  return { base64, mimeType }
}

const THUMBNAIL_MAX_DIMENSION = 300
const THUMBNAIL_QUALITY = 0.6

/**
 * Generate a small JPEG thumbnail from a base64-encoded image.
 * Returns the thumbnail as a plain base64 string (no data-URL prefix).
 */
export async function generateThumbnailBase64(
  base64: string,
  mimeType: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')

    if (!ctx) {
      reject(new Error('Failed to get canvas context'))
      return
    }

    img.onload = () => {
      let width = img.width
      let height = img.height

      if (width > THUMBNAIL_MAX_DIMENSION || height > THUMBNAIL_MAX_DIMENSION) {
        const ratio = THUMBNAIL_MAX_DIMENSION / Math.max(width, height)
        width = Math.floor(width * ratio)
        height = Math.floor(height * ratio)
      }

      canvas.width = width
      canvas.height = height
      ctx.drawImage(img, 0, 0, width, height)

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Failed to create thumbnail blob'))
            return
          }
          const reader = new FileReader()
          reader.onload = (e) => {
            if (e.target?.result) {
              const dataUrl = e.target.result as string
              resolve(dataUrl.split(',')[1])
            } else {
              reject(new Error('Failed to read thumbnail blob'))
            }
          }
          reader.onerror = () =>
            reject(new Error('Error reading thumbnail blob'))
          reader.readAsDataURL(blob)
        },
        'image/jpeg',
        THUMBNAIL_QUALITY,
      )
    }

    img.onerror = () => reject(new Error('Failed to load image for thumbnail'))
    img.src = `data:${mimeType};base64,${base64}`
  })
}
