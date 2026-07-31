import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else {
    print("Usage: swift ocr.swift <image-path>")
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: imageURL),
      let tiffData = image.tiffRepresentation,
      let imageSource = CGImageSourceCreateWithData(tiffData as CFData, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
    print("Error: Could not load image at \(imagePath)")
    exit(1)
}

struct OCRWord {
    let text: String
    let rect: CGRect
}

let requestHandler = VNImageRequestHandler(cgImage: cgImage, options: [:])
let request = VNRecognizeTextRequest { (request, error) in
    guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
    
    var words: [OCRWord] = []
    for observation in observations {
        if let candidate = observation.topCandidates(1).first {
            words.append(OCRWord(text: candidate.string, rect: observation.boundingBox))
        }
    }
    
    // Group words into lines based on Y coordinate overlap
    var lines: [[OCRWord]] = []
    for word in words {
        var added = false
        for i in 0..<lines.count {
            let lineY = lines[i][0].rect.origin.y
            let lineH = lines[i][0].rect.size.height
            // If the vertical position is close to the line Y
            let threshold = max(word.rect.size.height, lineH) * 0.7
            if abs(word.rect.origin.y - lineY) < threshold {
                lines[i].append(word)
                added = true
                break
            }
        }
        if !added {
            lines.append([word])
        }
    }
    
    // Sort lines from top to bottom (Y descending)
    lines.sort { $0[0].rect.origin.y > $1[0].rect.origin.y }
    
    // Sort words in each line from left to right (X ascending)
    for i in 0..<lines.count {
        lines[i].sort { $0.rect.origin.x < $1.rect.origin.x }
    }
    
    // Print reconstructed lines
    for line in lines {
        let lineStr = line.map { $0.text }.joined(separator: " | ")
        print(lineStr)
    }
}

request.recognitionLevel = .accurate

do {
    try requestHandler.perform([request])
} catch {
    print("OCR Error: \(error)")
    exit(1)
}
