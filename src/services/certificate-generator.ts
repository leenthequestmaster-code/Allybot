/**
 * @module certificate-generator
 * Pure in-memory vector PDF certificate generator for Allyssea Roleplay Community.
 * Generates official appreciation certificates with elegant double borders,
 * auto-centered typography, and digital seal without Chromium or external binaries.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

export interface CertificateOptions {
  readonly recipientName: string
  readonly title?: string
  readonly achievementText: string
  readonly certNumber?: string
  readonly dateText?: string
  readonly signatoryName?: string
  readonly signatoryRole?: string
}

export async function generateAllysseaCertificate(options: CertificateOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([842, 595]) // Landscape A4 (842 x 595 points)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica)
  const fontTimes = await doc.embedFont(StandardFonts.TimesRomanBold)

  const { width, height } = page.getSize()

  const gold = rgb(0.83, 0.68, 0.21)
  const navy = rgb(0.08, 0.12, 0.25)
  const darkGray = rgb(0.25, 0.25, 0.25)

  // Outer Navy Border
  page.drawRectangle({
    x: 20,
    y: 20,
    width: width - 40,
    height: height - 40,
    borderColor: navy,
    borderWidth: 3,
  })

  // Inner Gold Border
  page.drawRectangle({
    x: 28,
    y: 28,
    width: width - 56,
    height: height - 56,
    borderColor: gold,
    borderWidth: 1.5,
  })

  // Top Decorative Gold Vector Dots
  const centerX = width / 2
  const sealY = height - 55
  page.drawCircle({ x: centerX - 25, y: sealY, size: 3, color: gold })
  page.drawCircle({ x: centerX, y: sealY, size: 5, color: gold })
  page.drawCircle({ x: centerX + 25, y: sealY, size: 3, color: gold })

  // Header Title
  const header = 'KOMUNITAS ROLEPLAY ALLYSSEA'
  const hWidth = fontBold.widthOfTextAtSize(header, 14)
  page.drawText(header, {
    x: (width - hWidth) / 2,
    y: height - 80,
    size: 14,
    font: fontBold,
    color: gold,
  })

  const certTitle = options.title || 'PIAGAM PENGHARGAAN'
  const ctWidth = fontTimes.widthOfTextAtSize(certTitle, 30)
  page.drawText(certTitle, {
    x: (width - ctWidth) / 2,
    y: height - 125,
    size: 30,
    font: fontTimes,
    color: navy,
  })

  const sub = 'Diberikan dengan penuh kehormatan kepada:'
  const subWidth = fontRegular.widthOfTextAtSize(sub, 12)
  page.drawText(sub, {
    x: (width - subWidth) / 2,
    y: height - 170,
    size: 12,
    font: fontRegular,
    color: darkGray,
  })

  // Recipient Name
  const name = options.recipientName.trim()
  const nameWidth = fontTimes.widthOfTextAtSize(name, 36)
  page.drawText(name, {
    x: (width - nameWidth) / 2,
    y: height - 225,
    size: 36,
    font: fontTimes,
    color: gold,
  })

  // Underline under name
  page.drawLine({
    start: { x: (width - nameWidth) / 2 - 25, y: height - 235 },
    end: { x: (width + nameWidth) / 2 + 25, y: height - 235 },
    thickness: 1.2,
    color: gold,
  })

  // Achievement text
  const achievement = options.achievementText.trim()
  const aWidth = fontRegular.widthOfTextAtSize(achievement, 14)
  page.drawText(achievement, {
    x: (width - aWidth) / 2,
    y: height - 280,
    size: 14,
    font: fontRegular,
    color: navy,
  })

  // Date and Certificate ID
  const dateStr =
    options.dateText ||
    new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'long',
      timeZone: 'Asia/Jakarta',
    }).format(new Date())

  const certId = options.certNumber || `REG-ALLY-${Date.now().toString(36).toUpperCase()}`

  page.drawText(`Tanggal: ${dateStr}`, {
    x: 55,
    y: 85,
    size: 11,
    font: fontRegular,
    color: darkGray,
  })
  page.drawText(`No. Sertifikat: ${certId}`, {
    x: 55,
    y: 70,
    size: 10,
    font: fontRegular,
    color: rgb(0.4, 0.4, 0.4),
  })

  // Signatory
  const signatory = options.signatoryName || 'Cyrus'
  const sigRole = options.signatoryRole || 'Founder & System Lead'
  page.drawText(signatory, {
    x: width - 230,
    y: 95,
    size: 14,
    font: fontBold,
    color: navy,
  })
  page.drawText(sigRole, {
    x: width - 230,
    y: 78,
    size: 10,
    font: fontRegular,
    color: darkGray,
  })

  return await doc.save()
}
