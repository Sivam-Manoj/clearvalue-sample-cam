import React, { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import AssetFormSheet from "../components/forms/AssetFormSheet";

export default function HomeScreen() {
  const [formOpen, setFormOpen] = useState(true);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Camera Sample</Text>
      <TouchableOpacity style={styles.button} onPress={() => setFormOpen(true)}>
        <Text style={styles.buttonText}>Open Camera Check</Text>
      </TouchableOpacity>

      <AssetFormSheet visible={formOpen} onClose={() => setFormOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    backgroundColor: "#F9FAFB",
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 16,
  },
  button: {
    backgroundColor: "#2563EB",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
  },
  buttonText: {
    color: "#FFFFFF",
    fontWeight: "600",
  },
});
