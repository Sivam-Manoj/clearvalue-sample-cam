import { Feather } from "@expo/vector-icons";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CameraScreen as CameraCapture, MixedLot } from "../camera";
import LotManager from "./LotManager";

// Local lightweight shims so this sample camera screen can run standalone
type AssetCreateDetails = Record<string, any>;
type ServiceMixedLot = MixedLot;
type ProgressData = {
  serverProgress01?: number;
  message?: string;
  steps?: Array<{
    key?: string;
    label: string;
    endedAt?: string;
    durationMs?: number;
  }>;
};
type AutoSaveSummary = {
  exists: boolean;
  totalImages: number;
  totalLots: number;
  savedAt?: string;
};
type RestoredLotData = {
  id: string;
  mode?: MixedLot["mode"];
  mainImages: string[];
  extraImages: string[];
  videoFiles: string[];
  coverIndex: number;
};
type AutoSaveData = {
  formData: Record<string, any>;
  lots: RestoredLotData[];
  activeLotIdx: number;
};
type AutoSaveFormData = Record<string, any>;

const useAuth = () => ({ user: null as any });

const assetService = {
  createAssetReport: async (
    _details: AssetCreateDetails,
    _lots: ServiceMixedLot[],
    onProgress?: (progress: number) => void,
  ) => {
    onProgress?.(100);
  },
};

const AutoSaveService = {
  getAutoSaveSummary: async (): Promise<AutoSaveSummary> => ({
    exists: false,
    totalImages: 0,
    totalLots: 0,
    savedAt: undefined,
  }),
  getAutoSave: async () => null as AutoSaveData | null,
  saveAutoSave: async (
    _formData: AutoSaveFormData,
    _lots: MixedLot[],
    _activeLotIdx: number,
    _formType: "asset" | "realEstate",
  ) => {},
  deleteAutoSave: async () => {},
};

const OfflineQueueService = {
  isOnline: async () => true,
  enqueueAssetReport: async (
    _details: AssetCreateDetails,
    _lots: ServiceMixedLot[],
  ) => {},
  isNetworkError: (_error: unknown) => false,
};

const savedInputService = {
  create: async (_payload: unknown) => {},
};

const { height: SCREEN_HEIGHT } = Dimensions.get("window");

// Currency codes by region/locale
const CURRENCY_MAP: Record<string, string> = {
  "en-CA": "CAD",
  "en-US": "USD",
  "en-GB": "GBP",
  "en-AU": "AUD",
  "fr-CA": "CAD",
  "fr-FR": "EUR",
  "es-ES": "EUR",
  "es-MX": "MXN",
  "de-DE": "EUR",
  "it-IT": "EUR",
  "pt-BR": "BRL",
  "ja-JP": "JPY",
  "zh-CN": "CNY",
  "ko-KR": "KRW",
  "in-IN": "INR",
  "hi-IN": "INR",
};

// Lot mode types
export type LotMode = "single_lot" | "per_item" | "per_photo";

// MixedLot type is imported from CameraCapture

// Saved input data type
export interface SavedInputData {
  _id: string;
  name: string;
  formType: "asset" | "realEstate";
  formData: Record<string, any>;
}

interface AssetFormSheetProps {
  visible: boolean;
  onClose: () => void;
  savedInputData?: SavedInputData | null;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const LegacyAssetFormSheet = ({
  visible,
  onClose,
  savedInputData,
}: AssetFormSheetProps) => {
  const { user } = useAuth();

  // Form fields
  const [clientName, setClientName] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(isoDate(new Date()));
  const [appraisalPurpose, setAppraisalPurpose] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [appraiser, setAppraiser] = useState((user as any)?.username || "");
  const [appraisalCompany, setAppraisalCompany] = useState(
    (user as any)?.companyName || "",
  );
  const [industry, setIndustry] = useState("");
  const [inspectionDate, setInspectionDate] = useState(isoDate(new Date()));
  const [contractNo, setContractNo] = useState("");
  const [language, setLanguage] = useState<"en" | "fr" | "es">("en");
  const [currency, setCurrency] = useState("");
  const [currencyLoading, setCurrencyLoading] = useState(false);
  const [preparedFor, setPreparedFor] = useState("");
  const [factorsAgeCondition, setFactorsAgeCondition] = useState("");
  const [factorsQuality, setFactorsQuality] = useState("");
  const [factorsAnalysis, setFactorsAnalysis] = useState("");

  // Valuation methods
  const [includeValuationTable, setIncludeValuationTable] = useState(false);
  const [selectedValuationMethods, setSelectedValuationMethods] = useState<
    Array<"FML" | "TKV" | "OLV" | "FLV">
  >(["FML"]);

  // Lots state
  const [lots, setLots] = useState<MixedLot[]>([]);
  const activeStep: "images" = "images";

  // Camera state
  const [cameraOpen, setCameraOpen] = useState(false);
  const [activeLotIdx, setActiveLotIdx] = useState(-1);
  const [enhanceImages, setEnhanceImages] = useState(false); // Server-side enhancement toggle

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploadProgress, setUploadProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState<
    "idle" | "uploading" | "processing" | "done" | "error"
  >("idle");
  const [progressData, setProgressData] = useState<ProgressData | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  // Auto-save state
  const [showRestorePrompt, setShowRestorePrompt] = useState(false);
  const [autoSaveInfo, setAutoSaveInfo] = useState<{
    savedAt?: string;
    totalImages?: number;
    totalLots?: number;
  } | null>(null);
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Check for auto-saved data on mount
  useEffect(() => {
    if (visible && !savedInputData) {
      checkForAutoSave();
    }
  }, [visible, savedInputData]);

  const checkForAutoSave = async () => {
    try {
      const summary = await AutoSaveService.getAutoSaveSummary();
      if (summary.exists && summary.totalImages && summary.totalImages > 0) {
        setAutoSaveInfo({
          savedAt: summary.savedAt,
          totalImages: summary.totalImages,
          totalLots: summary.totalLots,
        });
        setShowRestorePrompt(true);
      }
    } catch (error) {
      console.error("Error checking auto-save:", error);
    }
  };

  const handleRestoreAutoSave = async () => {
    try {
      const data = await AutoSaveService.getAutoSave();
      if (data) {
        // Restore form data
        if (data.formData.clientName) setClientName(data.formData.clientName);
        if (data.formData.effectiveDate)
          setEffectiveDate(data.formData.effectiveDate);
        if (data.formData.appraisalPurpose)
          setAppraisalPurpose(data.formData.appraisalPurpose);
        if (data.formData.ownerName) setOwnerName(data.formData.ownerName);
        if (data.formData.appraiser) setAppraiser(data.formData.appraiser);
        if (data.formData.appraisalCompany)
          setAppraisalCompany(data.formData.appraisalCompany);
        if (data.formData.industry) setIndustry(data.formData.industry);
        if (data.formData.inspectionDate)
          setInspectionDate(data.formData.inspectionDate);
        if (data.formData.contractNo) setContractNo(data.formData.contractNo);
        if (data.formData.language) setLanguage(data.formData.language);
        if (data.formData.currency) setCurrency(data.formData.currency);
        if (data.formData.preparedFor)
          setPreparedFor(data.formData.preparedFor);
        if (data.formData.factorsAgeCondition)
          setFactorsAgeCondition(data.formData.factorsAgeCondition);
        if (data.formData.factorsQuality)
          setFactorsQuality(data.formData.factorsQuality);
        if (data.formData.factorsAnalysis)
          setFactorsAnalysis(data.formData.factorsAnalysis);
        if (typeof data.formData.includeValuationTable === "boolean")
          setIncludeValuationTable(data.formData.includeValuationTable);
        if (
          Array.isArray(data.formData.selectedValuationMethods) &&
          data.formData.selectedValuationMethods.length > 0
        ) {
          setSelectedValuationMethods(data.formData.selectedValuationMethods);
        }

        // Restore lots with images
        const restoredLots: MixedLot[] = data.lots.map(
          (savedLot: RestoredLotData) => ({
            id: savedLot.id,
            mode: savedLot.mode,
            files: savedLot.mainImages.map((uri: string, i: number) => ({
              uri,
              name: `restored-main-${i}.jpg`,
              type: "image/jpeg" as const,
            })),
            extraFiles: savedLot.extraImages.map((uri: string, i: number) => ({
              uri,
              name: `restored-extra-${i}.jpg`,
              type: "image/jpeg" as const,
            })),
            videoFile:
              savedLot.videoFiles.length > 0
                ? {
                    uri: savedLot.videoFiles[0],
                    name: "restored-video.mp4",
                    type: "video/mp4" as const,
                  }
                : undefined,
            coverIndex: savedLot.coverIndex,
          }),
        );

        if (restoredLots.length > 0) {
          setLots(restoredLots);
          setActiveLotIdx(data.activeLotIdx >= 0 ? data.activeLotIdx : 0);
        }

        Alert.alert(
          "Restored",
          `Restored ${data.lots.reduce((sum: number, l: RestoredLotData) => sum + l.mainImages.length + l.extraImages.length, 0)} images from ${data.lots.length} lot(s).`,
        );
      }
    } catch (error) {
      console.error("Error restoring auto-save:", error);
      Alert.alert("Error", "Failed to restore saved data.");
    }
    setShowRestorePrompt(false);
  };

  const handleDiscardAutoSave = async () => {
    try {
      await AutoSaveService.deleteAutoSave();
    } catch (error) {
      console.error("Error deleting auto-save:", error);
    }
    setShowRestorePrompt(false);
  };

  // Auto-save form data and images
  const triggerAutoSave = useCallback(async () => {
    // Clear any existing timeout
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    // Debounce auto-save (wait 2 seconds after last change)
    autoSaveTimeoutRef.current = setTimeout(async () => {
      try {
        const formData: AutoSaveFormData = {
          clientName,
          effectiveDate,
          appraisalPurpose,
          ownerName,
          appraiser,
          appraisalCompany,
          industry,
          inspectionDate,
          contractNo,
          language,
          currency,
          preparedFor,
          factorsAgeCondition,
          factorsQuality,
          factorsAnalysis,
          includeValuationTable,
          selectedValuationMethods,
        };

        await AutoSaveService.saveAutoSave(
          formData,
          lots,
          activeLotIdx,
          "asset",
        );
      } catch (error) {
        console.error("Auto-save error:", error);
      }
    }, 2000);
  }, [
    clientName,
    effectiveDate,
    appraisalPurpose,
    ownerName,
    appraiser,
    appraisalCompany,
    industry,
    inspectionDate,
    contractNo,
    language,
    currency,
    preparedFor,
    factorsAgeCondition,
    factorsQuality,
    factorsAnalysis,
    includeValuationTable,
    selectedValuationMethods,
    lots,
    activeLotIdx,
  ]);

  // Trigger auto-save when lots change (after image capture)
  useEffect(() => {
    if (
      lots.length > 0 &&
      lots.some((l) => l.files.length > 0 || l.extraFiles.length > 0)
    ) {
      triggerAutoSave();
    }
  }, [lots, triggerAutoSave]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, []);

  // State for saving inputs
  const [savingInputs, setSavingInputs] = useState(false);

  // Save inputs to server (like web version)
  const saveInputs = async () => {
    try {
      setSavingInputs(true);

      // Auto-generate name based on client name and date
      const baseName = clientName.trim() || "Unnamed";
      const dateStr = new Date().toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const autoName = `${baseName} - ${dateStr}`;

      const formData = {
        clientName,
        effectiveDate,
        appraisalPurpose,
        ownerName,
        appraiser,
        appraisalCompany,
        industry,
        inspectionDate,
        contractNo,
        language,
        currency,
        includeValuationTable,
        selectedValuationMethods,
        preparedFor,
        factorsAgeCondition,
        factorsQuality,
        factorsAnalysis,
      };

      await savedInputService.create({
        name: autoName,
        formType: "asset",
        formData,
      });

      Alert.alert("Success", "Inputs saved successfully!");
    } catch (error: any) {
      console.error("Error saving inputs:", error);
      Alert.alert(
        "Error",
        error?.response?.data?.message || "Failed to save inputs",
      );
    } finally {
      setSavingInputs(false);
    }
  };

  // Auto-detect currency on mount
  useEffect(() => {
    if (!currency && visible) {
      detectCurrency();
    }
  }, [visible]);

  // Pre-fill user data
  useEffect(() => {
    if (user && visible) {
      setAppraiser((user as any)?.username || "");
      setAppraisalCompany((user as any)?.companyName || "");
    }
  }, [user, visible]);

  // Load saved input data when provided
  useEffect(() => {
    if (savedInputData?.formData && visible) {
      const data = savedInputData.formData;
      // Populate form fields from saved data
      if (data.clientName) setClientName(data.clientName);
      if (data.effectiveDate) setEffectiveDate(data.effectiveDate);
      if (data.appraisalPurpose) setAppraisalPurpose(data.appraisalPurpose);
      if (data.ownerName) setOwnerName(data.ownerName);
      if (data.appraiser) setAppraiser(data.appraiser);
      if (data.appraisalCompany) setAppraisalCompany(data.appraisalCompany);
      if (data.industry) setIndustry(data.industry);
      if (data.inspectionDate) setInspectionDate(data.inspectionDate);
      if (data.contractNo) setContractNo(data.contractNo);
      if (data.language) setLanguage(data.language);
      if (data.currency) setCurrency(data.currency);
      if (data.preparedFor) setPreparedFor(data.preparedFor);
      if (data.factorsAgeCondition)
        setFactorsAgeCondition(data.factorsAgeCondition);
      if (data.factorsQuality) setFactorsQuality(data.factorsQuality);
      if (data.factorsAnalysis) setFactorsAnalysis(data.factorsAnalysis);
      if (typeof data.includeValuationTable === "boolean")
        setIncludeValuationTable(data.includeValuationTable);
      if (
        Array.isArray(data.selectedValuationMethods) &&
        data.selectedValuationMethods.length > 0
      ) {
        setSelectedValuationMethods(data.selectedValuationMethods);
      }
    }
  }, [savedInputData, visible]);

  const detectCurrency = async () => {
    setCurrencyLoading(true);
    setCurrency("USD");
    setCurrencyLoading(false);
  };

  const validateForm = (): boolean => {
    const e: Record<string, string> = {};
    if (lots.length === 0) e.lots = "Add at least one lot with images";

    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    const totalImages = lots.reduce(
      (sum, lot) => sum + lot.files.length + lot.extraFiles.length,
      0,
    );

    if (!validateForm()) {
      Alert.alert("Add Images", "Please capture at least one lot with images");
      return;
    }

    if (totalImages === 0) {
      Alert.alert("No Images", "Please add at least one image to submit");
      return;
    }

    const totalLots = lots.filter(
      (lot) => lot.files.length > 0 || lot.extraFiles.length > 0,
    ).length;
    Alert.alert(
      "Camera Check Complete",
      `Captured ${totalImages} image(s) across ${totalLots} lot(s).`,
    );
  };

  const resetForm = () => {
    setClientName("");
    setEffectiveDate(isoDate(new Date()));
    setAppraisalPurpose("");
    setOwnerName("");
    setAppraiser((user as any)?.username || "");
    setAppraisalCompany((user as any)?.companyName || "");
    setIndustry("");
    setInspectionDate(isoDate(new Date()));
    setContractNo("");
    setLanguage("en");
    setCurrency("");
    setPreparedFor("");
    setFactorsAgeCondition("");
    setFactorsQuality("");
    setFactorsAnalysis("");
    setIncludeValuationTable(false);
    setSelectedValuationMethods(["FML"]);
    setLots([]);
    setProgressPhase("idle");
    setUploadProgress(0);
    setProgressData(null);
    setJobId(null);
    setErrors({});
    // Re-detect currency
    detectCurrency();
  };

  const createLot = () => {
    const id = `lot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newLot: MixedLot = {
      id,
      files: [],
      extraFiles: [],
      coverIndex: 0,
    };
    setLots((prev) => [...prev, newLot]);
    setActiveLotIdx(lots.length);
    return lots.length;
  };

  const openCameraForLot = (lotIdx: number) => {
    setActiveLotIdx(lotIdx >= 0 ? lotIdx : 0);
    setCameraOpen(true);
  };

  const renderImagesStep = () => {
    const totalImages = lots.reduce(
      (sum, lot) => sum + lot.files.length + lot.extraFiles.length,
      0,
    );
    const totalLots = lots.filter(
      (lot) => lot.files.length > 0 || lot.extraFiles.length > 0,
    ).length;

    return (
      <View style={styles.imagesContainer}>
        {submitting && (
          <View style={styles.progressOverlay}>
            <View style={styles.progressCard}>
              <View style={styles.progressHeader}>
                {progressPhase === "done" ? (
                  <View
                    style={[
                      styles.progressIconBg,
                      { backgroundColor: "#D1FAE5" },
                    ]}
                  >
                    <Feather name="check" size={28} color="#059669" />
                  </View>
                ) : (
                  <View style={styles.progressIconBg}>
                    <ActivityIndicator size="large" color="#2563EB" />
                  </View>
                )}
                <Text style={styles.progressTitle}>
                  {progressPhase === "uploading"
                    ? "Uploading Images..."
                    : progressPhase === "done"
                      ? "Complete!"
                      : "Processing Report..."}
                </Text>
              </View>

              <View style={styles.progressStats}>
                <View style={styles.progressStat}>
                  <Text style={styles.progressStatValue}>{totalImages}</Text>
                  <Text style={styles.progressStatLabel}>Images</Text>
                </View>
                <View style={styles.progressStatDivider} />
                <View style={styles.progressStat}>
                  <Text style={styles.progressStatValue}>{totalLots}</Text>
                  <Text style={styles.progressStatLabel}>Lots</Text>
                </View>
              </View>

              <View style={styles.progressBarContainer}>
                <View
                  style={[
                    styles.progressBar,
                    {
                      width: `${
                        progressPhase === "uploading"
                          ? uploadProgress
                          : progressPhase === "done"
                            ? 100
                            : (progressData?.serverProgress01 || 0) * 100
                      }%`,
                      backgroundColor:
                        progressPhase === "done" ? "#059669" : "#2563EB",
                    },
                  ]}
                />
              </View>

              <Text style={styles.progressText}>
                {progressPhase === "uploading"
                  ? `${uploadProgress}% uploaded`
                  : progressPhase === "done"
                    ? "Report submitted successfully!"
                    : progressData?.message || "Please wait..."}
              </Text>

              {progressData?.steps && progressData.steps.length > 0 && (
                <View style={styles.stepsContainer}>
                  {progressData.steps.slice(-4).map((step, idx) => (
                    <View key={step.key || idx} style={styles.stepRow}>
                      <Feather
                        name={step.endedAt ? "check-circle" : "loader"}
                        size={14}
                        color={step.endedAt ? "#059669" : "#2563EB"}
                      />
                      <Text
                        style={[
                          styles.stepText,
                          step.endedAt && styles.stepTextDone,
                        ]}
                      >
                        {step.label}
                      </Text>
                      {step.durationMs && (
                        <Text style={styles.stepDuration}>
                          {(step.durationMs / 1000).toFixed(1)}s
                        </Text>
                      )}
                    </View>
                  ))}
                </View>
              )}
            </View>
          </View>
        )}

        <LotManager
          lots={lots}
          setLots={setLots}
          activeLotIdx={activeLotIdx}
          setActiveLotIdx={setActiveLotIdx}
          onOpenCamera={openCameraForLot}
          onCreateLot={createLot}
        />

        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[
              styles.submitButton,
              (submitting || totalImages === 0) && styles.submitButtonDisabled,
            ]}
            onPress={handleSubmit}
            disabled={submitting || totalImages === 0}
          >
            {submitting ? (
              <>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={[styles.submitButtonText, { marginLeft: 8 }]}>
                  {progressPhase === "uploading"
                    ? `${uploadProgress}%`
                    : "Processing..."}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.submitButtonText}>Done</Text>
                <Feather name="check" size={18} color="#fff" />
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Feather name="x" size={24} color="#374151" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Camera Check</Text>
          <View style={styles.stepIndicator}>
            <View style={styles.stepDot} />
            <View style={styles.stepLine} />
            <View
              style={[
                styles.stepDot,
                activeStep === "images" && styles.stepDotActive,
              ]}
            />
          </View>
        </View>

        <View style={styles.tabContainer}>
          <TouchableOpacity
            style={[styles.tabButton, styles.tabButtonActive]}
            activeOpacity={0.7}
          >
            <View style={styles.tabIconContainer}>
              <Feather name="image" size={20} color="#FFFFFF" />
            </View>
            <Text style={[styles.tabText, styles.tabTextActive]}>
              Lots & Images
            </Text>
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.content}
        >
          {renderImagesStep()}
        </KeyboardAvoidingView>

        <CameraCapture
          visible={cameraOpen}
          onClose={() => setCameraOpen(false)}
          lots={lots}
          setLots={setLots}
          activeLotIdx={activeLotIdx}
          setActiveLotIdx={setActiveLotIdx}
          onAutoSave={triggerAutoSave}
          enhanceImages={enhanceImages}
          onEnhanceChange={setEnhanceImages}
        />

        <Modal
          visible={showRestorePrompt}
          transparent
          animationType="fade"
          onRequestClose={() => setShowRestorePrompt(false)}
        >
          <View style={styles.restoreModalOverlay}>
            <View style={styles.restoreModalContent}>
              <View style={styles.restoreModalIcon}>
                <Feather name="refresh-cw" size={32} color="#2563EB" />
              </View>
              <Text style={styles.restoreModalTitle}>
                Restore Previous Session?
              </Text>
              <Text style={styles.restoreModalText}>
                Found {autoSaveInfo?.totalImages || 0} images from{" "}
                {autoSaveInfo?.totalLots || 0} lot(s)
                {autoSaveInfo?.savedAt &&
                  `\nSaved: ${new Date(autoSaveInfo.savedAt).toLocaleString()}`}
              </Text>
              <View style={styles.restoreModalButtons}>
                <TouchableOpacity
                  style={styles.restoreModalBtnDiscard}
                  onPress={handleDiscardAutoSave}
                >
                  <Feather name="trash-2" size={16} color="#EF4444" />
                  <Text style={styles.restoreModalBtnDiscardText}>Discard</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.restoreModalBtnRestore}
                  onPress={handleRestoreAutoSave}
                >
                  <Feather name="download" size={16} color="#fff" />
                  <Text style={styles.restoreModalBtnRestoreText}>Restore</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
};

const AssetFormSheet = ({ visible, onClose }: AssetFormSheetProps) => {
  const [lots, setLots] = useState<MixedLot[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [activeLotIdx, setActiveLotIdx] = useState(-1);
  const [enhanceImages, setEnhanceImages] = useState(false);

  const totalImages = lots.reduce(
    (sum, lot) => sum + lot.files.length + lot.extraFiles.length,
    0,
  );

  const createLot = () => {
    const id = `lot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newLot: MixedLot = {
      id,
      files: [],
      extraFiles: [],
      coverIndex: 0,
    };
    setLots((prev) => [...prev, newLot]);
    setActiveLotIdx(lots.length);
    return lots.length;
  };

  const openCameraForLot = (lotIdx: number) => {
    setActiveLotIdx(lotIdx >= 0 ? lotIdx : 0);
    setCameraOpen(true);
  };

  const handleDone = () => {
    if (totalImages === 0) {
      Alert.alert("Add Images", "Please capture at least one image.");
      return;
    }

    const totalLots = lots.filter(
      (lot) => lot.files.length > 0 || lot.extraFiles.length > 0,
    ).length;

    Alert.alert(
      "Camera Check Complete",
      `Captured ${totalImages} image(s) across ${totalLots} lot(s).`,
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Feather name="x" size={24} color="#374151" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Camera Check</Text>
          <View style={styles.stepIndicator}>
            <View style={styles.stepDot} />
            <View style={styles.stepLine} />
            <View style={[styles.stepDot, styles.stepDotActive]} />
          </View>
        </View>

        <View style={styles.tabContainer}>
          <View style={[styles.tabButton, styles.tabButtonActive]}>
            <View style={styles.tabIconContainer}>
              <Feather name="image" size={20} color="#FFFFFF" />
            </View>
            <Text style={[styles.tabText, styles.tabTextActive]}>
              Lots & Images
            </Text>
          </View>
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.content}
        >
          <View style={styles.imagesContainer}>
            <LotManager
              lots={lots}
              setLots={setLots}
              activeLotIdx={activeLotIdx}
              setActiveLotIdx={setActiveLotIdx}
              onOpenCamera={openCameraForLot}
              onCreateLot={createLot}
            />

            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[
                  styles.submitButton,
                  totalImages === 0 && styles.submitButtonDisabled,
                ]}
                onPress={handleDone}
                disabled={totalImages === 0}
              >
                <Text style={styles.submitButtonText}>Done</Text>
                <Feather name="check" size={18} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>

        <CameraCapture
          visible={cameraOpen}
          onClose={() => setCameraOpen(false)}
          lots={lots}
          setLots={setLots}
          activeLotIdx={activeLotIdx}
          setActiveLotIdx={setActiveLotIdx}
          enhanceImages={enhanceImages}
          onEnhanceChange={setEnhanceImages}
        />
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  closeButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#1F2937",
  },
  stepIndicator: {
    flexDirection: "row",
    alignItems: "center",
  },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#D1D5DB",
  },
  stepDotActive: {
    backgroundColor: "#2563EB",
  },
  stepLine: {
    width: 24,
    height: 2,
    backgroundColor: "#D1D5DB",
    marginHorizontal: 4,
  },
  // 3D Tab Navigation Styles
  tabContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F3F4F6",
    marginHorizontal: 16,
    marginVertical: 12,
    borderRadius: 16,
    padding: 4,
    position: "relative",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  tabBackground: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
  },
  tabSlider: {
    position: "absolute",
    width: "48%",
    height: "100%",
    backgroundColor: "#2563EB",
    borderRadius: 12,
    shadowColor: "#2563EB",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  tabButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 8,
    zIndex: 1,
  },
  tabButtonActive: {
    // Active state handled by slider background
  },
  tabIconContainer: {
    // Icon container for better alignment
  },
  tabText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#6B7280",
  },
  tabTextActive: {
    color: "#FFFFFF",
  },
  content: {
    flex: 1,
  },
  formScroll: {
    flex: 1,
  },
  formContent: {
    padding: 16,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 16,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
    borderWidth: 1,
    borderColor: "rgba(0, 0, 0, 0.04)",
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: "#1F2937",
    marginBottom: 10,
    letterSpacing: -0.3,
  },
  fieldContainer: {
    marginBottom: 10,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 5,
  },
  input: {
    backgroundColor: "#F9FAFB",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: "#1F2937",
  },
  inputError: {
    borderColor: "#DC2626",
  },
  // Date picker styles
  datePickerButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F9FAFB",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  datePickerText: {
    flex: 1,
    fontSize: 15,
    color: "#1F2937",
  },
  datePickerModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "flex-end",
  },
  datePickerModalContent: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 20,
  },
  datePickerModalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  datePickerModalTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1F2937",
  },
  datePickerCancelText: {
    fontSize: 16,
    color: "#6B7280",
  },
  datePickerDoneText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#2563EB",
  },
  iosDatePicker: {
    height: 200,
  },
  errorText: {
    fontSize: 12,
    color: "#DC2626",
    marginTop: 4,
  },
  textArea: {
    minHeight: 80,
    textAlignVertical: "top",
  },
  row: {
    flexDirection: "row",
  },
  currencyContainer: {
    flexDirection: "row",
    alignItems: "center",
  },
  currencyInput: {
    flex: 1,
  },
  currencyLoader: {
    marginLeft: -32,
    marginRight: 8,
  },
  languageRow: {
    flexDirection: "row",
  },
  langButton: {
    flex: 1,
    backgroundColor: "#F9FAFB",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    paddingVertical: 10,
    alignItems: "center",
    marginRight: 4,
    borderRadius: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  langButtonActive: {
    backgroundColor: "#2563EB",
    borderColor: "#2563EB",
    shadowColor: "#2563EB",
    shadowOpacity: 0.3,
    elevation: 4,
  },
  langText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#6B7280",
  },
  langTextActive: {
    color: "#fff",
  },
  toggleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#D1D5DB",
    justifyContent: "center",
    alignItems: "center",
  },
  checkboxActive: {
    backgroundColor: "#2563EB",
    borderColor: "#2563EB",
  },
  methodsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 12,
  },
  methodButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "#F9FAFB",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 12,
    marginRight: 8,
    marginBottom: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  methodButtonActive: {
    backgroundColor: "#DBEAFE",
    borderColor: "#2563EB",
    shadowColor: "#2563EB",
    shadowOpacity: 0.2,
    elevation: 3,
  },
  methodText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#6B7280",
  },
  methodTextActive: {
    color: "#2563EB",
    fontWeight: "700",
  },
  actionButtonsRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 16,
  },
  saveInputsButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#D1FAE5",
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "#059669",
    gap: 6,
    shadowColor: "#059669",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  saveInputsButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#059669",
  },
  nextButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2563EB",
    borderRadius: 14,
    paddingVertical: 14,
    shadowColor: "#2563EB",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  nextButtonText: {
    fontSize: 15,
    fontWeight: "800",
    color: "#fff",
    marginRight: 6,
    letterSpacing: -0.3,
  },
  imagesContainer: {
    flex: 1,
  },
  actionRow: {
    flexDirection: "row",
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: "#E5E7EB",
    backgroundColor: "#fff",
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#F3F4F6",
    borderRadius: 10,
    marginRight: 12,
  },
  backButtonText: {
    fontSize: 16,
    fontWeight: "500",
    color: "#374151",
    marginLeft: 6,
  },
  submitButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#059669",
    borderRadius: 10,
    paddingVertical: 14,
  },
  submitButtonDetails: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#059669",
    borderRadius: 14,
    paddingVertical: 14,
    marginTop: 12,
    marginBottom: 20,
    gap: 8,
    shadowColor: "#059669",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#fff",
    marginRight: 8,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  // Progress UI styles
  progressOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 100,
  },
  progressCard: {
    backgroundColor: "#fff",
    borderRadius: 22,
    padding: 22,
    width: "85%",
    maxWidth: 340,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 14,
    borderWidth: 1,
    borderColor: "rgba(0, 0, 0, 0.05)",
  },
  progressHeader: {
    alignItems: "center",
    marginBottom: 16,
  },
  progressIconBg: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#DBEAFE",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  progressTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#1F2937",
    textAlign: "center",
  },
  progressStats: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 20,
    paddingVertical: 12,
    paddingHorizontal: 24,
    backgroundColor: "#F9FAFB",
    borderRadius: 12,
  },
  progressStat: {
    alignItems: "center",
    paddingHorizontal: 16,
  },
  progressStatValue: {
    fontSize: 24,
    fontWeight: "bold",
    color: "#1F2937",
  },
  progressStatLabel: {
    fontSize: 12,
    color: "#6B7280",
    marginTop: 2,
  },
  progressStatDivider: {
    width: 1,
    height: 32,
    backgroundColor: "#E5E7EB",
  },
  progressBarContainer: {
    width: "100%",
    height: 8,
    backgroundColor: "#E5E7EB",
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 12,
  },
  progressBar: {
    height: "100%",
    backgroundColor: "#2563EB",
    borderRadius: 4,
  },
  progressText: {
    fontSize: 14,
    color: "#6B7280",
    textAlign: "center",
    marginBottom: 12,
  },
  stepsContainer: {
    width: "100%",
    marginTop: 8,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
  },
  stepText: {
    fontSize: 13,
    color: "#374151",
    marginLeft: 8,
    flex: 1,
  },
  stepTextDone: {
    color: "#059669",
  },
  stepDuration: {
    fontSize: 11,
    color: "#9CA3AF",
    marginLeft: 8,
  },
  progressHint: {
    fontSize: 13,
    color: "#9CA3AF",
    fontStyle: "italic",
    textAlign: "center",
    marginTop: 8,
  },
  // Restore modal styles
  restoreModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  restoreModalContent: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    width: "100%",
    maxWidth: 340,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 12,
  },
  restoreModalIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#EFF6FF",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  restoreModalTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#1F2937",
    marginBottom: 8,
    textAlign: "center",
  },
  restoreModalText: {
    fontSize: 14,
    color: "#6B7280",
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 20,
  },
  restoreModalButtons: {
    flexDirection: "row",
    gap: 12,
    width: "100%",
  },
  restoreModalBtnDiscard: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: "#FEE2E2",
    gap: 6,
  },
  restoreModalBtnDiscardText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#EF4444",
  },
  restoreModalBtnRestore: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: "#2563EB",
    gap: 6,
  },
  restoreModalBtnRestoreText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#fff",
  },
});

export default AssetFormSheet;
