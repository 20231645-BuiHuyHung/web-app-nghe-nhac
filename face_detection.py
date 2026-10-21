"""
Face Detection and Counting using OpenCV
Phát hiện và đếm số lượng khuôn mặt trong một bức ảnh
"""

import cv2
import sys
import os


def detect_faces(image_path, cascade_path=None):
    """
    Phát hiện khuôn mặt trong ảnh và trả về số lượng khuôn mặt tìm được
    
    Args:
        image_path (str): Đường dẫn đến file ảnh
        cascade_path (str): Đường dẫn đến file Haar Cascade (tùy chọn)
    
    Returns:
        tuple: (số lượng khuôn mặt, ảnh đã vẽ khung chữ nhật)
    """
    # Kiểm tra file ảnh tồn tại
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Không tìm thấy file ảnh: {image_path}")
    
    # Load ảnh
    image = cv2.imread(image_path)
    if image is None:
        raise ValueError(f"Không thể đọc file ảnh: {image_path}")
    
    # Chuyển sang ảnh xám (grayscale) để phát hiện khuôn mặt
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    
    # Load Haar Cascade classifier cho phát hiện khuôn mặt
    if cascade_path is None:
        # Sử dụng classifier tích hợp sẵn của OpenCV
        cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    
    face_cascade = cv2.CascadeClassifier(cascade_path)
    
    if face_cascade.empty():
        raise ValueError("Không thể load Haar Cascade classifier")
    
    # Phát hiện khuôn mặt
    # scaleFactor: Tỷ lệ thu nhỏ ảnh ở mỗi lần quét (1.1 = giảm 10% mỗi lần)
    # minNeighbors: Số lượng neighbor tối thiểu để giữ lại một phát hiện (cao hơn = ít false positive hơn)
    # minSize: Kích thước tối thiểu của khuôn mặt
    faces = face_cascade.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(30, 30),
        flags=cv2.CASCADE_SCALE_IMAGE
    )
    
    # Vẽ khung chữ nhật quanh các khuôn mặt phát hiện được
    for (x, y, w, h) in faces:
        cv2.rectangle(image, (x, y), (x + w, y + h), (0, 255, 0), 2)
        # Thêm text hiển thị số thứ tự khuôn mặt
        cv2.putText(image, f'Face {len([f for f in faces if f[0] <= x])}', 
                    (x, y - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
    
    # Thêm text hiển thị tổng số khuôn mặt
    cv2.putText(image, f'Total Faces: {len(faces)}', 
                (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
    
    return len(faces), image


def main():
    # Kiểm tra tham số dòng lệnh
    if len(sys.argv) < 2:
        print("Sử dụng: python face_detection.py <đường_dẫn_ảnh>")
        print("Ví dụ: python face_detection.py image.jpg")
        print("\nHoặc chạy không có tham số để dùng webcam:")
        print("python face_detection.py --webcam")
        return
    
    # Kiểm tra nếu muốn dùng webcam
    if sys.argv[1] == '--webcam':
        detect_faces_webcam()
        return
    
    image_path = sys.argv[1]
    
    try:
        print(f"Đang xử lý ảnh: {image_path}")
        face_count, result_image = detect_faces(image_path)
        
        print(f"Số lượng khuôn mặt phát hiện được: {face_count}")
        
        # Hiển thị kết quả
        cv2.imshow('Face Detection Result', result_image)
        print("Nhấn phím bất kỳ để thoát...")
        cv2.waitKey(0)
        cv2.destroyAllWindows()
        
        # Lưu kết quả (tùy chọn)
        output_path = os.path.splitext(image_path)[0] + '_detected.jpg'
        cv2.imwrite(output_path, result_image)
        print(f"Đã lưu kết quả tại: {output_path}")
        
    except Exception as e:
        print(f"Lỗi: {e}")


def detect_faces_webcam():
    """
    Phát hiện khuôn mặt real-time từ webcam
    """
    print("Khởi động webcam... Nhấn 'q' để thoát")
    
    # Load Haar Cascade
    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    
    # Mở webcam (0 = webcam mặc định)
    cap = cv2.VideoCapture(0)
    
    if not cap.isOpened():
        print("Không thể mở webcam")
        return
    
    while True:
        # Đọc frame từ webcam
        ret, frame = cap.read()
        if not ret:
            break
        
        # Chuyển sang grayscale
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # Phát hiện khuôn mặt
        faces = face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(30, 30)
        )
        
        # Vẽ khung chữ nhật
        for (x, y, w, h) in faces:
            cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 255, 0), 2)
        
        # Hiển thị số lượng khuôn mặt
        cv2.putText(frame, f'Faces: {len(faces)}', 
                    (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
        
        # Hiển thị frame
        cv2.imshow('Webcam Face Detection', frame)
        
        # Nhấn 'q' để thoát
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break
    
    # Giải phóng tài nguyên
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()