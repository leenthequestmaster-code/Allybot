/**
 * @module exif-inspector
 * High-speed camera metadata extractor and EXIF privacy verifier using exifr.
 */

import exifr from 'exifr'

export interface CameraExifInfo {
  readonly camera?: string
  readonly lens?: string
  readonly iso?: number
  readonly aperture?: string
  readonly shutterSpeed?: string
  readonly focalLength?: string
  readonly takenAt?: string
  readonly hasGps: boolean
  readonly latitude?: number
  readonly longitude?: number
}

/**
 * Inspects a binary image buffer and extracts photographic camera metadata.
 */
export async function inspectExif(buffer: Buffer): Promise<CameraExifInfo | null> {
  if (!buffer || buffer.length < 128) return null
  try {
    const data = await exifr.parse(buffer, {
      tiff: true,
      exif: true,
      gps: true,
    })

    if (!data) return null

    const make = typeof data.Make === 'string' ? data.Make.trim() : ''
    const model = typeof data.Model === 'string' ? data.Model.trim() : ''
    let camera: string | undefined = undefined
    if (make && model) {
      camera = model.startsWith(make) ? model : `${make} ${model}`
    } else if (model || make) {
      camera = model || make
    }

    let aperture: string | undefined = undefined
    if (typeof data.FNumber === 'number' && Number.isFinite(data.FNumber)) {
      aperture = `f/${data.FNumber}`
    }

    let shutterSpeed: string | undefined = undefined
    if (typeof data.ExposureTime === 'number' && Number.isFinite(data.ExposureTime)) {
      if (data.ExposureTime < 1 && data.ExposureTime > 0) {
        shutterSpeed = `1/${Math.round(1 / data.ExposureTime)}s`
      } else {
        shutterSpeed = `${data.ExposureTime}s`
      }
    }

    let focalLength: string | undefined = undefined
    if (typeof data.FocalLength === 'number' && Number.isFinite(data.FocalLength)) {
      focalLength = `${data.FocalLength}mm`
    }

    let takenAt: string | undefined = undefined
    if (data.DateTimeOriginal instanceof Date) {
      takenAt = new Intl.DateTimeFormat('id-ID', {
        dateStyle: 'medium',
        timeStyle: 'medium',
        timeZone: 'Asia/Jakarta',
      }).format(data.DateTimeOriginal)
    }

    const hasGps = typeof data.latitude === 'number' && typeof data.longitude === 'number'

    return {
      camera,
      lens: typeof data.LensModel === 'string' ? data.LensModel.trim() : undefined,
      iso: typeof data.ISO === 'number' ? data.ISO : undefined,
      aperture,
      shutterSpeed,
      focalLength,
      takenAt,
      hasGps,
      latitude: hasGps ? data.latitude : undefined,
      longitude: hasGps ? data.longitude : undefined,
    }
  } catch {
    return null
  }
}
